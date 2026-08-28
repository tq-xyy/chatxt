/**
 * 校验 API 响应，非 2xx 时解析错误体并抛出。
 */
export async function assertOk(resp: Response): Promise<Response> {
    if (resp.ok) return resp

    let errorText = await resp.text()
    try {
        const errorJSON = JSON.parse(errorText)
        errorText = errorJSON.error?.message || errorText
    } catch {
        // use original error text
    }

    const statusText =
        resp.statusText.length > 0
            ? `${resp.status} ${resp.statusText}`
            : `${resp.status}`

    throw new Error(
        `API Request Failed (${statusText}), error message: ${errorText}`
    )
}
