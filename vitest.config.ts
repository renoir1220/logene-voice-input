import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 所有测试统一用 node 环境（ArrayBuffer/DataView 在 Node.js 原生可用）
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
