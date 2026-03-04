"""Memoria Voice Service — entry point."""

import argparse
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


def talk_loop() -> None:
    """Space-to-talk loop with VAD end-of-speech detection."""
    import keyboard
    from config import cfg
    from state_machine import StateMachine, State
    from vad import SileroVAD
    import audio_io

    sr = cfg["sample_rate"]
    silence_ms = int(cfg["silence_duration"] * 1000)
    max_sec = cfg["max_recording"]
    threshold = cfg["vad_threshold"]

    sm = StateMachine()
    vad = SileroVAD(threshold=threshold)

    print("=== Memoria Voice — Talk Mode ===")
    print("Press Space to talk, Ctrl+C to quit.\n")

    try:
        while True:
            print(f"[{sm.state.name}] Press Space to talk...")
            keyboard.wait("space")

            sm.transition(State.LISTENING)
            audio_io.play_tone()
            print(f"[{sm.state.name}] 正在听...")

            vad.reset()
            audio = audio_io.stream_record_with_vad(
                vad,
                sample_rate=sr,
                silence_ms=silence_ms,
                max_seconds=max_sec,
            )

            sm.transition(State.IDLE)
            duration = len(audio) / sr
            peak = float(audio.max()) if len(audio) > 0 else 0.0
            print(f"录音结束 — {duration:.1f}s, peak: {peak:.4f}\n")

    except KeyboardInterrupt:
        print("\nBye!")
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
        help="Space-to-talk mode with VAD end-of-speech detection",
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
            talk_loop()
        except Exception as e:
            print(f"Talk mode failed: {e}", file=sys.stderr)
            sys.exit(1)
        return

    print("Usage: python main.py --test-audio | --talk")
    print("  --test-audio   Record 5s and play back")
    print("  --talk         Space-to-talk with VAD")
    sys.exit(0)


if __name__ == "__main__":
    main()
