import type {
    OpenAICompatibleRequest,
    OpenAICompatibleResponse,
} from '../types/apis/openai-compatible-api'
import type { JSONSchema7 as JSONSchema } from 'json-schema'

type WithFalsy<T> = T | null | undefined | false

export type ChatxtToolAPI = {
    context: {
        toolPath: string
        chatFilePath: string
        chatFileDirname: string
        chatxtVersion: string
    }
    runtime: {
        exposeTool(
            tools: WithFalsy<{
                name: string
                description: string
                parameters: JSONSchema
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                func: (arg: any) => any
            }>[]
        ): Promise<void>
        chatCompletion(
            request: Omit<OpenAICompatibleRequest, 'model'> & {
                model?: string
            }
        ): Promise<OpenAICompatibleResponse>
    }
    helpers: {
        convertArgsToSchema(
            argsDefs: [
                string,
                string,
                (
                    | StringConstructor
                    | NumberConstructor
                    | BooleanConstructor
                    | JSONSchema
                ),
                { optional?: boolean }?,
            ][]
        ): JSONSchema
    }
}
