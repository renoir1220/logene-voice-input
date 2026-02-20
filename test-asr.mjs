#!/usr/bin/env node
// 测试 ASR 链路：生成一段静音 WAV，发送到 ASR 服务器，验证响应格式
// 用法：node test-asr.mjs [server_url]

const serverUrl = process.argv[2] || 'http://localhost:3000'

// 生成 1 秒 16kHz 单声道静音 WAV（全零 PCM）
function makeSilenceWav(durationSec = 1) {
  const sampleRate = 16000
  const numSamples = sampleRate * durationSec
  const buf = Buffer.alloc(44 + numSamples * 2, 0)

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) buf[offset + i] = str.charCodeAt(i)
  }
  const writeU32 = (offset, v) => buf.writeUInt32LE(v, offset)
  const writeU16 = (offset, v) => buf.writeUInt16LE(v, offset)

  writeStr(0, 'RIFF')
  writeU32(4, 36 + numSamples * 2)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  writeU32(16, 16)
  writeU16(20, 1)           // PCM
  writeU16(22, 1)           // 单声道
  writeU32(24, sampleRate)
  writeU32(28, sampleRate * 2)
  writeU16(32, 2)
  writeU16(34, 16)
  writeStr(36, 'data')
  writeU32(40, numSamples * 2)
  // PCM 数据全零（静音）

  return buf
}

async function testAsr() {
  const url = `${serverUrl.replace(/\/$/, '')}/api/tasks/asr-recognize/sync`
  console.log(`[测试] 发送静音 WAV 到 ${url}`)

  const wav = makeSilenceWav(1)
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'test.wav')

  try {
    const resp = await fetch(url, { method: 'POST', body: form })
    console.log(`[测试] HTTP 状态: ${resp.status}`)
    const body = await resp.json()
    console.log('[测试] 响应:', JSON.stringify(body, null, 2))

    if (resp.ok) {
      console.log('[测试] ✓ ASR 服务器连通，响应格式正常')
    } else {
      console.log('[测试] ✗ 服务器返回错误状态')
    }
  } catch (e) {
    console.log(`[测试] ✗ 请求失败: ${e.message}`)
    console.log('  → 请确认 ASR 服务器已启动，地址:', serverUrl)
  }
}

// 测试语音指令匹配逻辑
function testVoiceCommands() {
  const commands = {
    肉眼所见: 'ALT+R',
    保存报告: 'F2',
    上一个: 'ALT+A',
  }

  const cases = [
    ['肉眼所见', 'command', 'ALT+R'],
    ['肉眼所见。', 'command', 'ALT+R'],   // 带标点
    ['  保存报告  ', 'command', 'F2'],    // 带空格
    ['你好世界', 'text', '你好世界'],
  ]

  console.log('\n[测试] 语音指令匹配:')
  let pass = 0
  for (const [input, expectedType, expectedVal] of cases) {
    const trimmed = input.trim()
    const stripped = trimmed.replace(/^[\s。，！？、；：.,!?;:"'「」""'']+|[\s。，！？、；：.,!?;:"'「」""'']+$/gu, '')
    const matched = commands[stripped]
    const type = matched ? 'command' : 'text'
    const val = matched || trimmed

    const ok = type === expectedType && val === expectedVal
    console.log(`  ${ok ? '✓' : '✗'} "${input}" → ${type}:${val}  (期望 ${expectedType}:${expectedVal})`)
    if (ok) pass++
  }
  console.log(`  结果: ${pass}/${cases.length} 通过`)
}

testVoiceCommands()
testAsr()
