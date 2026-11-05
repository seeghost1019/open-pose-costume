# Qwen-Image 2.1 WebUI 規格與網站串接紀錄

這份文件記錄三件事：

1. Colab 上 Qwen-Image 2.1 Gradio WebUI 的規格
2. 網站與 WebUI 的串接方式
3. 相關的架構決定與待辦事項

供之後維護，或在新的對話中接續使用。

> 本文以 `webui.example.com`（WebUI）和 `api.example.com`（轉接器）代表你的網域，`example.com` 代表你在 Cloudflare 管理的網域；實際操作時請換成你自己的。
>
> **規格來源**：使用者 WebUI 筆記本的 cell 6、12、16 與 `qwen_mcp/core.py`，由使用者整理提供。**尚未對實際的 WebUI 連線驗證**。
> 串接程式只在本機用「依此規格模擬的 Gradio app」（Gradio 6.31、gradio_client 2.7.2）測試過，詳見[驗證紀錄](#驗證紀錄)。

---

## 1. WebUI 連線

| 項目 | 內容 |
|---|---|
| 對外網址 | `https://webui.example.com` |
| 對外方式 | Cloudflare Tunnel，轉到 `127.0.0.1:7860`（只聽本機） |
| 協定 | Gradio（`gradio_client`），**不是**自訂 JSON REST API |
| 認證 | Gradio 帳密 `auth=(WEBUI_USER, WEBUI_PASS)`，不使用 Cloudflare Access |
| 密碼規則 | 少於 12 字不啟動；12～15 字可啟動但會警告 |
| 上傳上限 | `max_file_size="20mb"` |
| 佇列 | `MAX_QUEUE=10` |
| GPU 排程 | 三個端點共用 `concurrency_id="gpu"`，依序執行 |
| 自動關機 | 閒置 30 分鐘（`IDLE_SHUTDOWN_MINUTES`） |
| 模型 | `MAIN_MODEL` 預設 `Qwen/Qwen-Image-2.1`，可改用 `Qwen/Qwen-Image-2.1-Turbo`。**本站使用 Turbo 權重（8 步）** |

---

## 2. 端點

參數都是**位置參數**，必須照下列順序傳。三個端點都回傳 `(預覽圖, 原檔 WebP 路徑, 說明 Markdown)`。

### `/t2i` 文生圖

```
prompt, ratio, width, height, steps, seed, lora_on, lora_scale, transparent
```

### `/edit` 單圖編輯

```
image, prompt, output_resolution, size, width, height, steps, seed, lora_on, lora_scale, transparent
```

### `/multi` 多圖合成（網站使用這個）

```
files, prompt, steps, seed, lora_on, lora_scale, output_resolution, size, width, height, transparent
```

- `files` 是 Gallery 格式：`[{"image": handle_file(path), "caption": None}, ...]`
- ⚠️ 參數順序和 `/edit` 不同：`steps`、`seed` 排在前面。

### 呼叫範例

```python
from gradio_client import Client, handle_file

c = Client("https://webui.example.com", auth=(user, password))

# 文生圖
img, file, info = c.predict("一隻貓", "16:9", 2048, 2048, 40, -1,
                            False, 1.0, False, api_name="/t2i")

# 多圖合成
files = [{"image": handle_file(p), "caption": None} for p in ["pose.png", "outfit.png"]]
img, file, info = c.predict(files, "穿上服裝", 40, -1, False, 1.0,
                            1328, "auto", 2048, 2048, False, api_name="/multi")
```

---

## 3. 參數限制

| 參數 | 規格 | 預設 |
|---|---|---|
| `prompt` | 不可空白 | — |
| `ratio` | `1:1`、`4:3`、`3:4`、`3:2`、`2:3`、`16:9`、`9:16`、`custom` | `1:1` |
| `size` | `auto`（不傳寬高）、上列比例、`custom` | `auto` |
| `width`／`height` | 512～3072，64 的倍數；只在 `custom` 時使用 | 2048 |
| `steps` | 10～60（Gradio 會拒絕超出範圍的值） | 40 |
| `seed` | 整數，`-1` 表示隨機，上限 2^63−1 | −1 |
| `output_resolution` | 512～2048，16 的倍數 | 1328 |
| 參考圖張數 | 2～10，介面建議 2～8 | — |
| `lora_on` | NSFW LoRA 開關 | `False` |
| `lora_scale` | 0～2，每次調整 0.05 | 1.0 |
| `transparent` | 透明背景 | `False` |

### 比例對應的像素

| 比例 | 寬 × 高 |
|---|---|
| 1:1 | 2048 × 2048 |
| 4:3／3:4 | 2400 × 1792／1792 × 2400 |
| 3:2／2:3 | 2528 × 1696／1696 × 2528 |
| 16:9／9:16 | 2752 × 1536／1536 × 2752 |

---

## 4. 行為

- **輸出格式**：WebP，品質 92，檔案內嵌 prompt 與參數。`transparent=True` 時改用無損 WebP。
- **透明背景**：
  - `/t2i` 會自動加上官方的 RGBA 句型。
  - `/edit`、`/multi` 只保留 alpha 通道，prompt 裡要自己寫明背景透明。
- **記憶體不足**：`VAE_TILING=False` 時，會自動開啟切塊處理，並用同一個 seed 重跑一次。再失敗就回報「顯存不足」。
- **輸入不符規格**：回傳 `gr.Error` 訊息。用 `gradio_client` 呼叫時會變成 `AppError`。
- **R2**：啟用時，生成結果會在背景上傳到 `qwen/outputs/`。
- **本機 MCP**：也可以透過 qwen-image MCP 呼叫，工具有 `generate_image`、`edit_image`、`multi_image`、`expand_prompt`。

---

## 5. 網站串接方式

```
網站（seeghost1019.github.io/open-pose-costume）
   │  POST https://api.example.com/v1/images/edits
   │  Authorization: Bearer <OPC_API_KEY>
   ▼
Cloudflare Tunnel（與 webui.example.com 同一條，多一個公開主機名稱）
   ▼
轉接器 127.0.0.1:8000（colab/opc_image_adapter.py，在同一個 Colab 執行）
   │  gradio_client，帳密 WEBUI_USER / WEBUI_PASS
   ▼
Gradio WebUI 127.0.0.1:7860 → /multi
```

設定步驟見 [`docs/colab-gradio-adapter-guide.md`](colab-gradio-adapter-guide.md)。

### 轉接器的參數對應

| 網站送出 | 傳給 `/multi` |
|---|---|
| `image[]`（姿勢、服裝、選填的人物，2～3 張） | `files`，順序不變 |
| `prompt`（網站組好的繁體中文提示詞） | `prompt` |
| `size`：`1024x1024`／`2048x2048` | `size="1:1"` |
| `size`：`1024x1536` | `size="2:3"` |
| `size`：`1536x1024` | `size="3:2"` |
| `size`：`auto` | `size="auto"` |
| `quality`：low／medium／high／auto | `steps`：20／30／40／40；設定 `steps=10` 時一律傳 10 |
| （固定值） | `seed=-1`、`lora_on=False`、`lora_scale=1.0`、`output_resolution=1328`、`width=height=2048`、`transparent=False` |

回傳的原檔 WebP 會轉成 `{"data":[{"b64_json": ...}]}`。失敗時回傳 `{"error":{"message": ...}}`。

### 重要決定

| 決定 | 原因 |
|---|---|
| 網站不直接連 Gradio，改用轉接器 | Gradio 帳密不能放進瀏覽器；網站已支援 OpenAI 格式，不必實作 Gradio 協定。本機模擬時，跨網域登入後的請求會回 401。 |
| 網站用的金鑰 `OPC_API_KEY` 和 WebUI 密碼分開 | 金鑰外洩時，只要換網站用的那組，WebUI 不受影響。 |
| Turbo 固定傳 `steps=10` | WebUI 的 `steps` 最小值是 10，傳 8 會被拒絕（已實測）。Turbo 權重自帶 8 步排程，只設定 `num_inference_steps` 不會改變它。**待實際確認**：進度條應顯示 8/8。 |
| 每 10 秒送一個空白字元保持連線 | Cloudflare 會切斷 100 秒內沒有回應的連線（524）。JSON 允許開頭有空白；網站會把帶有 `error` 欄位的回應當成失敗。 |
| 網站生圖等待上限改成 10 分鐘 | 原本只有 3 分鐘，但錯誤訊息寫「10 分鐘」；WebUI 也需要排隊時間。 |
| CORS 只允許本站網址 | 允許 `seeghost1019.github.io`、`localhost:5199`、`127.0.0.1:5199`。 |

---

## 6. 網域與主機

| 網址 | 用途 | 設定 |
|---|---|---|
| `seeghost1019.github.io/open-pose-costume/` | 網站（GitHub Pages，不使用自訂網域） | — |
| `webui.example.com` | Gradio WebUI | Cloudflare Tunnel → `127.0.0.1:7860` |
| `api.example.com` | 網站用的生圖轉接器 | 同一條 Tunnel → `127.0.0.1:8000` |

---

## 7. 之前完成的網站變更

| 項目 | PR |
|---|---|
| 網站用語改成台灣繁體中文：OpenCC `twp` 加上修正表 `scripts/zh-tw.mjs`；素材目錄在建置時轉換；搜尋支援繁、簡體 | [#1](https://github.com/seeghost1019/open-pose-costume/pull/1) |
| CI 用 `actions/configure-pages` 依 Pages 設定自動判斷網址路徑 | [#2](https://github.com/seeghost1019/open-pose-costume/pull/2) |
| 不使用自訂網域，網址改回 GitHub Pages | [#4](https://github.com/seeghost1019/open-pose-costume/pull/4) |
| 生圖改接 WebUI：轉接器、教學、等待上限改為 10 分鐘 | [#3](https://github.com/seeghost1019/open-pose-costume/pull/3) |

---

## 8. 驗證紀錄

在本機用依本規格模擬的 Gradio app 驗證（含帳密、`/multi` 參數順序、`concurrency_id="gpu"`、`max_file_size="20mb"`、`gr.Error`）：

- ✅ `/multi` 收到的位置參數順序與值正確。
- ✅ `steps=8` 被 Gradio 拒絕：`Value 8 is less than minimum value 10.`；`steps=10` 正常。
- ✅ `gr.Error("顯存不足")` 會原樣顯示在網站上。
- ✅ 用網站本身的 `generateReferenceImage()` 呼叫轉接器，成功拿到 WebP。
- ✅ 金鑰錯誤回 401；少於 2 張圖、非圖片檔都會被拒絕。
- ✅ 允許的網址可以呼叫，其他網址會被瀏覽器擋下（CORS）。
- ✅ Gradio 重新啟動後，轉接器自動重新連線。
- ⏳ **尚未對實際 WebUI 驗證**：真實的回傳格式、Turbo 實際步數、生成時間。

---

## 9. 待辦事項

- [ ] 合併 PR #3 後，依 `docs/colab-gradio-adapter-guide.md` 完成 Colab 與 Tunnel 設定，並實際生成一張圖。
- [ ] 確認 Turbo 進度條顯示 8/8；若顯示 10/10，考慮把 WebUI 的 `steps` 最小值改成 8，轉接器改傳 `steps=8`。
- [ ] 生影片：WebUI 目前沒有影片端點。之後要提供影片 API 規格；網站需新增影片介面與非同步任務流程。
- [ ] 更換分享預覽圖 `public/social/omilic-x-card.png`：目前是原作者的簡體版，上面印著 omilic.com。
- [ ] `index.html` 的 `twitter:site` 還是原作者的 `@HongyeMain`。

---

## 10. 授權提醒

Qwen-Image 2.1 採用 **Qwen Research License**，**只能非商業使用**。商業使用需另向 Qwen 取得授權（`model-business@notice.qwencloud.com`）。
