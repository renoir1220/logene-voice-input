use reqwest::multipart;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct AsrResponse {
    data: Option<AsrData>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AsrData {
    text: String,
}

/// 调用 ASR API 识别语音
pub async fn recognize(
    server_url: &str,
    asr_config_id: &str,
    wav_bytes: Vec<u8>,
) -> Result<String, String> {
    let url = format!("{}/api/tasks/asr-recognize/sync", server_url.trim_end_matches('/'));

    let file_part = multipart::Part::bytes(wav_bytes)
        .file_name("recording.wav")
        .mime_str("audio/wav")
        .map_err(|e| format!("构建 multipart 失败: {e}"))?;

    let form = multipart::Form::new()
        .part("file", file_part)
        .text("asrConfigId", asr_config_id.to_string());

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("ASR 请求失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("ASR 返回错误状态: {}", resp.status()));
    }

    let body: AsrResponse = resp
        .json()
        .await
        .map_err(|e| format!("解析 ASR 响应失败: {e}"))?;

    if let Some(err) = body.error {
        return Err(format!("ASR 错误: {err}"));
    }

    body.data
        .map(|d| d.text)
        .ok_or_else(|| "ASR 响应中无 data 字段".to_string())
}
