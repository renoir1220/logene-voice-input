declare module 'sql.js' {
  export interface Statement {
    bind(values: unknown[]): void
    step(): boolean
    getAsObject(): Record<string, unknown>
    free(): void
  }

  export interface Database {
    prepare(sql: string): Statement
    run(sql: string, params?: unknown[]): void
    export(): Uint8Array
    close(): void
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array | ArrayBuffer) => Database
  }

  export default function initSqlJs(config?: {
    locateFile?: (file: string) => string
  }): Promise<SqlJsStatic>
}
