# 網站生圖改接 Colab 上的 Qwen-Image 2.1 WebUI 教學

讓網站的「一鍵生圖」改用你在 Colab 上架設的 Qwen-Image 2.1 Gradio WebUI（`https://qwen.seeghost.win`），使用 **Qwen-Image 2.1 Turbo** 權重（8 步出圖）。

完整的 WebUI 規格、架構決定與待辦事項，見 [`docs/qwen-webui-spec.md`](qwen-webui-spec.md)。

## 架構

```
網站（pose.seeghost.win）
   │  POST https://api.seeghost.win/v1/images/edits（Authorization: Bearer <OPC_API_KEY>）
   ▼
Cloudflare Tunnel（與 qwen.seeghost.win 同一條，多加一個公開主機名稱）
   │
   ▼
Colab：轉接器 127.0.0.1:8000（colab/opc_image_adapter.py）
   │  gradio_client，帳密 WEBUI_USER / WEBUI_PASS
   ▼
Colab：Gradio WebUI 127.0.0.1:7860 → /multi 多圖合成
```

### 為什麼要加轉接器，而不是讓網站直接連 Gradio

- **保護 WebUI 密碼**：網站只拿到另一組 `OPC_API_KEY`，WebUI 帳密只存在 Colab 裡。
- **不用改網站的協定**：網站本來就支援 OpenAI 格式的 `/v1/images/edits`，轉接器負責轉成 Gradio 的 `/multi` 呼叫。
- **不怕 Cloudflare 切斷連線**：Cloudflare 會切斷 100 秒內沒有任何回應的連線（524 錯誤）。轉接器會先回應，並每 10 秒送一個空白字元保持連線。

## 參數對應

網站一次送 2～3 張參考圖：姿勢、服裝、選填的人物。轉接器會照順序交給 `/multi`。

| 網站設定 | 傳給 `/multi` 的值 |
|---|---|
| 畫面尺寸 `1024x1024`、`2048x2048` | `size="1:1"`（2048×2048） |
| 畫面尺寸 `1024x1536` | `size="2:3"`（1696×2528） |
| 畫面尺寸 `1536x1024` | `size="3:2"`（2528×1696） |
| 畫面尺寸 `auto` | `size="auto"` |
| 品質（任何選項） | `steps=10`（Turbo 固定設定，見下方說明） |
| （固定值） | `seed=-1`、`lora_on=False`、`lora_scale=1.0`、`output_resolution=1328`、`width=height=2048`、`transparent=False` |

### Turbo 的步數為什麼傳 10

- WebUI 的 `steps` 只接受 10～60，直接傳 `8` 會被 Gradio 拒絕（`Value 8 is less than minimum value 10.`）。
- Turbo 權重自帶 **8 步取樣排程**。依官方說明，只設定 `num_inference_steps` 不會改變這個排程，所以傳 `10` 實際仍是跑 8 步。
- 這個前提成立的條件是：你的 WebUI 只把 `steps` 當成 `num_inference_steps` 傳給 diffusers。請用第 4 步的方法確認一次。
- 如果之後改回非 Turbo 的 `Qwen/Qwen-Image-2.1`，把第 3 步的 `steps=10` 拿掉，就會改成依網站品質選項送 20／30／40 步。

WebUI 回傳的原檔 WebP 會直接交給網站顯示。WebUI 的錯誤訊息（例如「顯存不足」）也會原樣顯示在網站上。

---

## 第 1 步：在 Colab 新增密鑰 `OPC_API_KEY`

1. 打開你的 Qwen-Image WebUI 筆記本。
2. 點左側欄的 🔑 **鑰匙圖示**（Secrets／密鑰）→ **「+ 新增密鑰」**。
3. **名稱**填 `OPC_API_KEY`，**值**填一組你自己想的長密碼，建議 30 個以上的英數字。
4. 打開右邊的 **「筆記本存取權」** 開關。

> 這組密碼是網站用的，**不要**和 WebUI 的 `WEBUI_PASS` 用同一組。

---

## 第 2 步：在 Cloudflare Tunnel 新增 `api.seeghost.win`

把新的主機名稱加到 `qwen.seeghost.win` 用的**同一條 Tunnel** 上，不用另外執行 cloudflared。

1. 打開 <https://one.dash.cloudflare.com>（Cloudflare Zero Trust）並登入。
2. 左側選單點 **「Networks」→「Tunnels」**。
3. 找到 `qwen.seeghost.win` 用的那條 Tunnel，點右邊的 **「⋯」→「Configure」**。
4. 切到 **「Public Hostname」** 分頁，點 **「Add a public hostname」**。
5. 填入：

   | 欄位 | 填什麼 |
   |---|---|
   | **Subdomain** | `api` |
   | **Domain** | `seeghost.win` |
   | **Path** | 留空 |
   | **Service → Type** | `HTTP` |
   | **Service → URL** | `127.0.0.1:8000` |

6. 點 **「Save hostname」**。

> 如果你的 Tunnel 是用 `config.yml` 在本機管理，而不是在網頁上管理，請改在 `ingress:` 的最後一條（catch-all）之前加上：
>
> ```yaml
>   - hostname: api.seeghost.win
>     service: http://127.0.0.1:8000
> ```
>
> 然後重新啟動 cloudflared。

---

## 第 3 步：在筆記本新增轉接器儲存格

在筆記本裡**啟動 Gradio WebUI 的那個儲存格之後**，新增一個程式碼儲存格，貼上：

```python
!pip install -q gradio_client fastapi uvicorn python-multipart
!wget -q -O opc_image_adapter.py https://raw.githubusercontent.com/seeghost1019/open-pose-costume/main/colab/opc_image_adapter.py

from google.colab import userdata
from opc_image_adapter import Settings, create_app, gradio_backend, serve

backend = gradio_backend("http://127.0.0.1:7860", (WEBUI_USER, WEBUI_PASS), steps=10)  # Turbo：實際仍是 8 步
adapter = serve(create_app(backend, Settings(api_key=userdata.get("OPC_API_KEY"))), port=8000)
```

執行後應該會看到：

```
Adapter listening on http://127.0.0.1:8000
```

> - 執行前，請確認 WebUI 的 `MAIN_MODEL` 已設為 `Qwen/Qwen-Image-2.1-Turbo`。
> - `WEBUI_USER`、`WEBUI_PASS` 是 WebUI 筆記本裡原本的帳密變數。如果名稱不同，請改成你的變數名稱。
> - 這段程式碼會從 GitHub 的 `main` 分支下載轉接器，所以要等這次的 PR 合併後才能用。
> - 每次重新啟動 Colab，都要在 WebUI 啟動後再執行一次這個儲存格。

---

## 第 4 步：確認轉接器已對外上線

用瀏覽器打開 <https://api.seeghost.win/health>，看到下面這行就代表成功：

```json
{"ok":true}
```

### 確認 Turbo 真的只跑 8 步（建議做一次）

在網站生成第一張圖時，看一下 Colab 裡 WebUI 儲存格的輸出：diffusers 的進度條應該顯示 **8/8**，而不是 10/10。

如果顯示 10/10，代表你的 WebUI 用了自己的步數設定，會覆蓋 Turbo 的排程。這時有兩個做法：

- 接受 10 步：速度稍慢，品質通常不受影響。
- 把 WebUI 的 `steps` 滑桿最小值改成 8，再把第 3 步的 `steps=10` 改成 `steps=8`。

---

## 第 5 步：在網站上設定

1. 打開 <https://pose.seeghost.win/>。
2. 點右上角 ⚙️ **「生圖設定」**。
3. 填入：

   | 欄位 | 填什麼 |
   |---|---|
   | **服務網址** | `https://api.seeghost.win` |
   | **API Key** | 和 Colab 的 `OPC_API_KEY` 一樣 |
   | **模型** | `qwen-image-2.1-turbo`（任意非空白文字皆可，實際使用的模型由 WebUI 的 `MAIN_MODEL` 決定） |

4. 視需要勾選「在此瀏覽器記住金鑰」，點 **「儲存設定」**。
5. 進入 **「一鍵生圖」**，選好姿勢和服裝後點 **「生成圖片」**。

> 網站最多等 10 分鐘。WebUI 一次只跑一張圖，其他請求會排隊。

---

## 遇到問題時

| 狀況 | 原因與解法 |
|---|---|
| 網站顯示「HTTP 401 · Invalid API key」 | 網站填的 API Key 和 `OPC_API_KEY` 不一致。 |
| 網站顯示「暫時無法連線生圖服務」 | Colab 已停止、WebUI 閒置 30 分鐘後自動關機，或轉接器沒有啟動。先打開 `https://api.seeghost.win/health` 確認；打不開就重新啟動 WebUI，再執行第 3 步的儲存格。 |
| 「Generation failed: 顯存不足」 | WebUI 的 VRAM 不夠。改用較大的 GPU。 |
| 「Generation failed: …401…」或「…Unauthorized…」 | 轉接器登入 WebUI 失敗。確認第 3 步的 `WEBUI_USER`、`WEBUI_PASS` 正確。 |
| 「At least 2 reference images are required.」 | `/multi` 至少需要 2 張參考圖。請先選好姿勢和服裝。 |
| `https://api.seeghost.win/health` 顯示 502 或 1033 | Tunnel 有連上，但連不到轉接器。重新執行第 3 步的儲存格。 |
| 網站顯示「生成超過 10 分鐘」 | 排隊太久，或 WebUI 卡住。查看 Colab 輸出，必要時重新啟動 WebUI 和轉接器。 |

---

## 安全說明

- 轉接器只聽本機 `127.0.0.1:8000`，只能透過 Cloudflare Tunnel 從外部連線。
- 每個請求都要帶正確的 `Authorization: Bearer <OPC_API_KEY>`，比對時使用固定時間比較，避免被以時間差猜出金鑰。
- 瀏覽器只允許從 `pose.seeghost.win`、`seeghost1019.github.io` 與本機開發網址呼叫（CORS）。
- 參考圖只接受 PNG／JPEG／WebP，每張最大 20 MB、最多 10 張；處理完會立刻刪除暫存檔。
