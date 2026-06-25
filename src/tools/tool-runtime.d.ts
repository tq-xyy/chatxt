// toolkit.d.ts
export {} // 确保这是模块

declare global {
    function serveAsTool(
        ...entries: [(...args: any[]) => any, string, any][]
    ): Promise<never>

    function ToJSONSchema(
        argsDefs: [
            string,
            string,
            { new (...args: any[]): any },
            { optional?: boolean }?,
        ][]
    ): {
        type: 'object'
        properties: Record<string, { type: string; description: string }>
        required: string[]
    }
}
