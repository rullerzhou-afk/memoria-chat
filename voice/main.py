"""Memoria Voice Service — entry point."""

import argparse
import asyncio
import sys


def test_audio() -> None:
    """Record 5 seconds from the mic and play it back."""
    from config import cfg
    import audio_io

    sr = cfg["sample_rate"]
    ch = cfg["channels"]

    print("=== Audio devices ===")
    audio_io.list_devices()
    print()

    print(f"开始录音（5 秒）...  [sample_rate={sr}, channels={ch}]")
    audio = audio_io.record(seconds=5, sample_rate=sr, channels=ch)
    peak = audio.max()
    print(f"录音结束 — {len(audio)} samples, peak amplitude: {peak:.4f}")

    if peak < 0.001:
        print("⚠ 几乎没有检测到声音，请检查麦克风是否正常工作")

    print("播放中...")
    audio_io.play(audio, sample_rate=sr)
    print("测试完成 ✓")


# ----------------------------------------------------------------------
# Async talk loop
# ----------------------------------------------------------------------

async def wait_for_trigger(
    events: list[asyncio.Event],
    timeout: float | None,
) -> bool:
    """Wait for ANY of the given events.  Returns True if fired, False on timeout.

    Caller must clear() events beforehand if stale triggers should be
    discarded (e.g. after PROCESSING).  We do NOT clear here so that a
    trigger during tone playback is not lost.
    """
    if not events:
        # No trigger configured — block forever (shouldn't happen)
        await asyncio.sleep(3600)
        return False

    async def _wait_one(evt: asyncio.Event) -> None:
        await evt.wait()

    tasks = [asyncio.create_task(_wait_one(e)) for e in events]
    try:
        if timeout is None:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        else:
            _done, _pending = await asyncio.wait(
                tasks, timeout=timeout, return_when=asyncio.FIRST_COMPLETED
            )
            if not _done:
                return False
        return True
    finally:
        for t in tasks:
            t.cancel()
        # Suppress CancelledError from tasks we just cancelled
        for t in tasks:
            try:
                await t
            except asyncio.CancelledError:
                pass


async def _listen_and_transcribe(
    vad, sr: int, silence_ms: int, max_sec: float,
    local_stt, client, language: str,
    wake_listener,
) -> str | None:
    """Record via VAD -> STT -> return text, or None on failure.

    Pauses wake_listener during recording (mic sharing).
    Uses try/finally to guarantee resume even on error.
    """
    import audio_io

    if wake_listener:
        wake_listener.pause()
    try:
        print("[LISTENING] 正在听...")

        vad.reset()
        audio = await asyncio.to_thread(
            audio_io.stream_record_with_vad,
            vad, sample_rate=sr,
            silence_ms=silence_ms,
            max_seconds=max_sec,
        )

        duration = len(audio) / sr
        if duration < 0.3:
            print("(录音太短，已忽略)\n")
            return None

        # Ding after recording — confirms "I heard you, processing now"
        await asyncio.to_thread(audio_io.play_tone)
        print(f"[PROCESSING] 识别中... ({duration:.1f}s)")
        try:
            if local_stt:
                text = await local_stt.transcribe(audio, sr=sr)
            else:
                wav_bytes = audio_io.numpy_to_wav_bytes(audio, sample_rate=sr)
                text = await client.transcribe(wav_bytes, language=language)
        except Exception as e:
            print(f"Error: STT 失败 ({e})\n")
            return None

        if not text or not text.strip():
            print("(未识别到内容)\n")
            return None

        return text.strip()
    finally:
        if wake_listener:
            wake_listener.resume()


async def _do_speak(
    sm, client, session,
    tts_voice: str, tts_speed: float,
    triggers: list[asyncio.Event],
    space_event: asyncio.Event, wake_event: asyncio.Event,
    wake_listener,
    vad, sr: int, silence_ms: int, max_sec: float,
    local_stt, language: str,
) -> None:
    """Run AI pipeline with barge-in support.  Loops on repeated barge-ins.

    Enters in SPEAKING state.  Exits in IDLE state.
    On barge-in: interrupts pipeline -> listens -> transcribes -> speaks again.
    """
    import audio_io
    from pipeline import run_pipeline, ChatError
    from state_machine import State

    while True:
        # --- Run pipeline with concurrent trigger monitoring ---
        print(f"[{sm.state.name}] AI 回复中...")

        # Fresh cancel event per pipeline (old pipeline keeps its own signal)
        pipeline_cancel = asyncio.Event()

        # Pause wake word listener during SPEAKING (prevent AI voice self-trigger)
        if wake_listener:
            wake_listener.pause()

        # Discard stale triggers before monitoring
        space_event.clear()
        wake_event.clear()

        pipeline_task = asyncio.create_task(run_pipeline(
            client=client,
            messages=session.messages,
            cancel=pipeline_cancel,
            tts_voice=tts_voice,
            tts_speed=tts_speed,
        ))

        # Monitor for trigger (barge-in) while pipeline runs
        trigger_task = asyncio.create_task(
            wait_for_trigger(triggers, timeout=None)
        )

        done, _ = await asyncio.wait(
            {pipeline_task, trigger_task},
            return_when=asyncio.FIRST_COMPLETED,
        )

        barged_in = trigger_task in done and not pipeline_task.done()

        if barged_in:
            # === Barge-in: stop audio immediately, don't wait for pipeline ===
            print("[BARGE-IN] 打断 AI")
            pipeline_cancel.set()
            audio_io.get_tts_player().interrupt()
            pipeline_task.cancel()  # abort in-flight HTTP calls

            # Wait for pipeline to finish — it catches CancelledError
            # and returns partial PipelineResult
            try:
                result = await pipeline_task
            except (asyncio.CancelledError, Exception) as e:
                if not isinstance(e, asyncio.CancelledError):
                    print(f"Warning: pipeline cleanup error: {e}")
                result = None

            # Save partial AI response (so frontend and context see it)
            if result and result.full_text:
                print(f"AI (interrupted): {result.full_text}")
                try:
                    await session.add_assistant_message(result.full_text)
                except Exception as e:
                    print(f"Warning: 回复保存失败 ({e})")
        else:
            # === Normal completion ===
            trigger_task.cancel()
            try:
                await trigger_task
            except asyncio.CancelledError:
                pass

        # Resume wake word listener
        if wake_listener:
            wake_listener.resume()

        # Process pipeline result (only available when not barged_in)
        if not barged_in:
            try:
                result = pipeline_task.result()
            except ChatError as e:
                print(f"Error: AI 回复错误 ({e})")
                sm.transition(State.IDLE)
                return
            except Exception as e:
                print(f"Error: AI 回复失败 ({e})")
                sm.transition(State.IDLE)
                return

            if result.full_text:
                print(f"AI: {result.full_text}")
                try:
                    await session.add_assistant_message(result.full_text)
                except Exception as e:
                    print(f"Warning: 回复保存失败 ({e})")
                if result.meta:
                    m = result.meta
                    print(
                        f"  [{m.get('model', '')}] "
                        f"{m.get('total_tokens', 0)} tokens"
                    )
            else:
                print("(AI 无回复)")

            sm.transition(State.IDLE)
            return

        # === Barge-in path: listen for new user input ===
        sm.transition(State.LISTENING)
        text = await _listen_and_transcribe(
            vad, sr, silence_ms, max_sec,
            local_stt, client, language, wake_listener,
        )
        if text is None:
            sm.transition(State.IDLE)
            return

        sm.transition(State.PROCESSING)
        print(f"You: {text}")
        try:
            await session.add_user_message(text)
        except Exception as e:
            print(f"Warning: 消息保存失败 ({e})")

        # Loop back to SPEAKING for the new response (supports repeated barge-ins)
        sm.transition(State.SPEAKING)


async def talk_loop() -> None:
    """Async talk loop: record → STT → AI chat → TTS → playback."""
    from config import cfg
    from state_machine import StateMachine, State
    from vad import SileroVAD
    import audio_io
    from audio_io import REMIND_PATTERN, BYE_PATTERN
    from memoria_client import MemoriaClient
    from session import Session
    from stt import make_transcriber
    sr = cfg["sample_rate"]
    silence_ms = int(cfg["silence_duration"] * 1000)
    max_sec = cfg["max_recording"]
    threshold = cfg["vad_threshold"]
    language = cfg["language"]
    idle_remind_m = cfg["idle_remind_m"]
    idle_remind_wait_s = cfg["idle_remind_wait_s"]
    tts_voice = cfg["tts_voice"]
    tts_speed = cfg.get("tts_speed", 1.0)
    trigger_mode = cfg.get("trigger_mode", "keypress")

    sm = StateMachine()
    vad = SileroVAD(threshold=threshold)

    # Local STT: load model once, reuse across recordings (None = API mode)
    local_stt = make_transcriber(cfg["stt_provider"], cfg["stt_model"], language)
    client = MemoriaClient(
        base_url=cfg["memoria_url"],
        admin_token=cfg["admin_token"],
    )
    session = Session(client, timeout_m=cfg["session_timeout"])

    # Bridge keyboard events → asyncio
    loop = asyncio.get_running_loop()
    space_event = asyncio.Event()

    use_keypress = trigger_mode in ("keypress", "both")
    use_wakeword = trigger_mode in ("wakeword", "both")

    keyboard = None
    if use_keypress:
        import keyboard as _kb
        keyboard = _kb
        keyboard.on_press_key("space", lambda _: loop.call_soon_threadsafe(space_event.set))

    # Wake word listener (Step 5)
    wake_event = asyncio.Event()
    wake_listener = None
    if use_wakeword:
        from wakeword import WakeWordListener
        wake_words_raw = cfg.get("wake_word", "你好小鹿")
        wake_words = [w.strip() for w in wake_words_raw.split(",") if w.strip()]
        wake_listener = WakeWordListener(
            wake_event=wake_event,
            loop=loop,
            wake_words=wake_words,
            keywords_threshold=cfg.get("wake_threshold", 0.25),
            keywords_score=cfg.get("wake_score", 1.0),
        )
        wake_listener.start()

    # Pre-warm audio player + STT model in parallel
    warmup = [asyncio.to_thread(audio_io.get_tts_player, 24000)]
    if local_stt:
        warmup.append(asyncio.to_thread(local_stt.warm))
    await asyncio.gather(*warmup)

    # Build trigger list once (events don't change during the loop)
    triggers = []
    if use_keypress:
        triggers.append(space_event)
    if use_wakeword:
        triggers.append(wake_event)

    trigger_hint = []
    if use_keypress:
        trigger_hint.append("Space")
    if use_wakeword:
        trigger_hint.append(f"wake word ({wake_words_raw})")
    hint = " or ".join(trigger_hint)

    print("=== Memoria Voice — Talk Mode ===")
    print(f"Trigger: {hint} | Ctrl+C to quit.\n")

    # Try creating initial conversation (non-fatal if server is down)
    try:
        await session.ensure_conversation()
    except Exception as e:
        print(f"Warning: 无法连接服务器 ({e})，稍后重试\n")

    try:
        while True:
            # ============================================================
            # IDLE — wait for trigger (Space / wake word) or idle timeout
            # ============================================================
            if sm.state == State.IDLE:
                idle_timeout = idle_remind_m * 60 if idle_remind_m > 0 else None
                # Discard stale triggers from PROCESSING
                space_event.clear()
                wake_event.clear()

                print(f"[{sm.state.name}] Waiting for trigger...")
                triggered = await wait_for_trigger(triggers, timeout=idle_timeout)

                if not triggered:
                    # Idle timeout → remind
                    print(f"[{sm.state.name}] 还在吗？")
                    await asyncio.to_thread(audio_io.play_tone_pattern, REMIND_PATTERN)
                    # Don't clear events here — user may have triggered during the tone
                    triggered = await wait_for_trigger(triggers, timeout=idle_remind_wait_s)
                    if not triggered:
                        # No response → sleep
                        print(f"[{sm.state.name}] 晚安～")
                        await asyncio.to_thread(audio_io.play_tone_pattern, BYE_PATTERN)
                        sm.transition(State.SLEEPING)
                        continue

                # Triggered → ensure conversation exists
                try:
                    await session.ensure_conversation()
                except Exception as e:
                    print(f"Error: 创建对话失败 ({e})")

                # Listen + transcribe
                sm.transition(State.LISTENING)
                text = await _listen_and_transcribe(
                    vad, sr, silence_ms, max_sec,
                    local_stt, client, language, wake_listener,
                )
                if text is None:
                    sm.transition(State.IDLE)
                    continue

                sm.transition(State.PROCESSING)
                print(f"You: {text}")

                # Persist user message (non-fatal)
                try:
                    await session.add_user_message(text)
                except Exception as e:
                    print(f"Warning: 消息保存失败 ({e})")

                # --- AI response pipeline (with barge-in support) ---
                # _do_speak loops internally on barge-ins, returns in IDLE
                sm.transition(State.SPEAKING)
                await _do_speak(
                    sm, client, session,
                    tts_voice, tts_speed,
                    triggers, space_event, wake_event,
                    wake_listener,
                    vad, sr, silence_ms, max_sec,
                    local_stt, language,
                )

            # ============================================================
            # SLEEPING — wait for trigger (Space / wake word) to wake up
            # ============================================================
            elif sm.state == State.SLEEPING:
                space_event.clear()
                wake_event.clear()
                print(f"[{sm.state.name}] Waiting for trigger to wake up...")
                await wait_for_trigger(triggers, timeout=None)
                print("(醒来了)\n")
                sm.transition(State.IDLE)

    except KeyboardInterrupt:
        print("\nBye!")
    finally:
        if wake_listener:
            wake_listener.stop()
        if keyboard:
            keyboard.unhook_all()
        audio_io.close_tts_player()
        await client.close()
        sm.reset()


def main() -> None:
    parser = argparse.ArgumentParser(description="Memoria Voice Service")
    parser.add_argument(
        "--test-audio",
        action="store_true",
        help="Record 5 seconds and play back (hardware sanity check)",
    )
    parser.add_argument(
        "--talk",
        action="store_true",
        help="Space-to-talk mode with STT and conversation persistence",
    )
    args = parser.parse_args()

    if args.test_audio:
        try:
            test_audio()
        except Exception as e:
            print(f"Audio test failed: {e}", file=sys.stderr)
            sys.exit(1)
        return

    if args.talk:
        try:
            asyncio.run(talk_loop())
        except Exception as e:
            print(f"Talk mode failed: {e}", file=sys.stderr)
            sys.exit(1)
        return

    print("Usage: python main.py --test-audio | --talk")
    print("  --test-audio   Record 5s and play back")
    print("  --talk         Space-to-talk with STT")
    sys.exit(0)


if __name__ == "__main__":
    main()
