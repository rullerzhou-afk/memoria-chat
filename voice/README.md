# Memoria Voice Service

Python 语音服务，为 Memoria.chat 提供语音交互能力。

## 前置依赖

### Windows / macOS

无需额外操作，`sounddevice` 自带 PortAudio 二进制。

### Linux (Debian/Ubuntu)

```bash
sudo apt install libportaudio2
```

### Linux (Fedora/RHEL)

```bash
sudo dnf install portaudio
```

## 快速开始

```bash
cd voice
pip install -r requirements.txt
```

### 硬件测试

```bash
python main.py --test-audio
```

预期流程：
1. 打印可用音频设备列表
2. 开始录音（5 秒）
3. 录完自动播放
4. 从音箱听到自己的声音即为成功

### Talk 模式（语音转文字 + 对话持久化）

**前置条件**：Node.js 服务运行中（`npm start`），`OPENAI_API_KEY` 已配置。

```bash
python main.py --talk
```

预期流程：
1. 首次运行自动下载 Silero VAD 模型（~2.2MB）
2. 打印 `[Session] 新对话: xxxxx` + `[IDLE] Press Space to talk...`
3. 按 Space → 听到"叮" → 终端显示 `[LISTENING] 正在听...`
4. 对着麦克风说几句话
5. 停顿约 1.5 秒 → 自动结束录音 → `[PROCESSING] 识别中...`
6. 打印 `You: <识别出的文字>`，消息同步到 Web 端
7. 回到 `[IDLE]`，等待下次按键
8. 空闲 2 分钟 → 播放提醒音 → 15 秒无响应 → 播放再见音 → `[SLEEPING]`
9. SLEEPING 状态按 Space → 唤醒回到 IDLE
10. Ctrl+C 退出

## 配置

编辑 `config.yaml` 或通过环境变量覆盖：

| 环境变量 | 配置键 | 默认值 | 说明 |
|---|---|---|---|
| `SAMPLE_RATE` | `sample_rate` | `16000` | 采样率 |
| `CHANNELS` | `channels` | `1` | 声道数 |
| `MEMORIA_URL` | `memoria_url` | `http://127.0.0.1:3000` | 服务地址 |
| `ADMIN_TOKEN` | `admin_token` | (空) | 鉴权 token |
| `VAD_THRESHOLD` | `vad_threshold` | `0.5` | 语音检测阈值 0~1 |
| `SILENCE_DURATION` | `silence_duration` | `1.5` | 静音多久算说完（秒） |
| `MAX_RECORDING` | `max_recording` | `60` | 录音上限（秒） |
| `LANGUAGE` | `language` | `auto` | STT 语言，`auto`=自动检测 |
| `STT_PROVIDER` | `stt_provider` | `local` | `local`=faster-whisper, `local-torch`=openai-whisper+PyTorch, `api`=服务端 |
| `STT_MODEL` | `stt_model` | `small` | Whisper 模型: tiny/base/small/medium/large-v3 |
| `SESSION_TIMEOUT` | `session_timeout` | `30` | 对话超时（分钟），超时新建 |
| `IDLE_REMIND_M` | `idle_remind_m` | `2` | 空闲提醒（分钟），0=禁用 |
| `IDLE_REMIND_WAIT_S` | `idle_remind_wait_s` | `15` | 提醒后等待（秒） |
| `TRIGGER_MODE` | `trigger_mode` | `keypress` | `keypress`=Space, `wakeword`=语音唤醒, `both`=两者 |
| `WAKE_WORD` | `wake_word` | `小莫` | 唤醒词（中英文均可，逗号分隔多个） |
| `WAKE_THRESHOLD` | `wake_threshold` | `0.25` | 唤醒词检测阈值（越大越难触发） |
| `WAKE_SCORE` | `wake_score` | `1.0` | 关键词增强分数（越大越容易通过） |

> **Security**: Use environment variables for `ADMIN_TOKEN`. Never put real tokens in `config.yaml` (it's tracked by git).

### 唤醒词模式（可选）

默认只用 Space 按键触发。要启用语音唤醒：

1. 安装 sherpa-onnx：`pip install sherpa-onnx`（已在 requirements.txt 中）
2. 修改 `config.yaml`：`trigger_mode: "both"`（或 `"wakeword"` 纯语音）
3. 设置唤醒词：`wake_word: "小莫,梅莫利亚"`（中文均可，多个用逗号分隔）
4. 首次运行会自动下载 KWS 模型（~20MB）

唤醒词基于 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 的 zipformer 中英双语 KWS 模型，支持任意中文/英文关键词，无需训练。

### AMD GPU 加速（可选）

默认使用 `faster-whisper`（CPU），AMD 显卡用户可切换到 `local-torch` 获得 GPU 加速：

1. 安装 AMD 驱动 Adrenalin 26.1.1+
2. 按 [AMD 官方文档](https://rocm.docs.amd.com/) 安装 ROCm PyTorch wheels（**不要**用 pip 默认的 torch，会装成 CPU 版）
3. 安装 openai-whisper：`pip install openai-whisper`
4. 修改 `config.yaml`：`stt_provider: "local-torch"`
5. 验证 GPU 识别：`python -c "import torch; print(torch.cuda.get_device_name(0))"`

## 项目结构

```
voice/
├── main.py              # 入口（--test-audio / --talk）
├── config.py            # 配置加载
├── config.yaml          # 默认配置
├── state_machine.py     # 状态机定义
├── audio_io.py          # 麦克风录音 + 播放 + VAD 录音 + WAV 编码
├── vad.py               # Silero VAD V5 ONNX 封装
├── stt.py               # 本地 STT（faster-whisper / openai-whisper+PyTorch）
├── wakeword.py          # 唤醒词检测（sherpa-onnx KWS）
├── memoria_client.py    # Memoria API 异步客户端
├── session.py           # 会话生命周期管理
├── models/              # VAD + KWS 模型（自动下载，不入 git）
├── requirements.txt     # Python 依赖
└── README.md
```
