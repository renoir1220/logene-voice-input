class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const requestedSize = Number(options?.processorOptions?.chunkSize)
    this.chunkSize = Number.isFinite(requestedSize) && requestedSize >= 128
      ? Math.floor(requestedSize)
      : 1024
    this.buffer = new Float32Array(this.chunkSize * 2)
    this.length = 0

    this.port.onmessage = (event) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'flush') {
        this.flush()
      }
    }
  }

  ensureCapacity(extra) {
    const needed = this.length + extra
    if (needed <= this.buffer.length) return
    let nextLength = this.buffer.length
    while (nextLength < needed) nextLength *= 2
    const next = new Float32Array(nextLength)
    next.set(this.buffer.subarray(0, this.length), 0)
    this.buffer = next
  }

  append(samples) {
    if (!samples || samples.length === 0) return
    this.ensureCapacity(samples.length)
    this.buffer.set(samples, this.length)
    this.length += samples.length
    this.emitChunks()
  }

  emitChunks() {
    while (this.length >= this.chunkSize) {
      this.port.postMessage(this.buffer.slice(0, this.chunkSize))
      this.buffer.copyWithin(0, this.chunkSize, this.length)
      this.length -= this.chunkSize
    }
  }

  flush() {
    if (this.length > 0) {
      this.port.postMessage(this.buffer.slice(0, this.length))
      this.length = 0
    }
    this.port.postMessage({ type: 'flushed' })
  }

  process(inputs) {
    const firstInput = inputs[0]
    const channel = firstInput && firstInput[0]
    if (channel && channel.length > 0) {
      this.append(channel)
    }
    return true
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor)
