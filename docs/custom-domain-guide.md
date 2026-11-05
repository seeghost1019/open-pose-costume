# 自訂網域 pose.seeghost.win 設定教學

把放在 GitHub Pages 上的網站，接到自己的網域 `https://pose.seeghost.win/`。

- 倉庫：<https://github.com/seeghost1019/open-pose-costume>
- 目前網址：<https://seeghost1019.github.io/open-pose-costume/>
- 目標網址：<https://pose.seeghost.win/>

> **為什麼不用 Cloudflare Tunnel？**
> Tunnel 是用來把你自己電腦上的伺服器公開到網路上，那台電腦必須 24 小時開著。這個網站是放在 GitHub Pages 上的靜態網站，不需要你自己的電腦，直接設定自訂網域就好。

照第 1 步到第 6 步的順序做。

---

## 第 1 步：合併 PR #2

PR #2 已修改好部署流程，會**自動判斷**網址路徑：有設定自訂網域就用 `/`，沒有就維持 `/open-pose-costume/`。所以先合併或先設網域都可以，網站不會壞掉。

1. 打開 <https://github.com/seeghost1019/open-pose-costume/pull/2>
2. 拉到頁面下方，確認檢查項目都是綠色勾勾 ✅。
3. 點綠色按鈕 **「Merge pull request」**，再點 **「Confirm merge」**。

> 這時網站還在原本的 `seeghost1019.github.io/open-pose-costume/`，可以照常使用。

---

## 第 2 步：在 Cloudflare 新增 DNS 記錄

1. 打開 <https://dash.cloudflare.com> 並登入。
2. 在首頁的網域列表裡，點 **`seeghost.win`**。
3. 左側選單點 **「DNS」**，再點 **「Records」**（記錄）。
4. 點藍色按鈕 **「+ Add record」**（新增記錄）。
5. 依序填入：

   | 欄位 | 填什麼 |
   |---|---|
   | **Type**（類型） | 選 `CNAME` |
   | **Name**（名稱） | 填 `pose` |
   | **Target**（目標） | 填 `seeghost1019.github.io` |
   | **Proxy status**（Proxy 狀態） | 點一下橘色雲朵，讓它變成**灰色**，旁邊顯示 **「DNS only」** |
   | **TTL** | 維持 `Auto` |

6. 點 **「Save」**（儲存）。

> ⚠️ **雲朵一定要是灰色（DNS only）。** 橘色代表流量會先經過 Cloudflare，GitHub 會因此驗證不了網域、也發不出 HTTPS 憑證，第 4 步就會卡住。

---

## 第 3 步：在 GitHub 填入自訂網域

1. 打開 <https://github.com/seeghost1019/open-pose-costume/settings/pages>
2. 找到 **「Custom domain」** 輸入框，填入：

   ```
   pose.seeghost.win
   ```

3. 點旁邊的 **「Save」**。
4. 下方會先顯示「DNS check in progress」（檢查中），通常幾秒到幾分鐘後會變成 ✅ **「DNS check successful」**。

> 如果顯示「DNS check unsuccessful」，多半是 DNS 記錄還沒生效。等 5～10 分鐘後，重新整理頁面再看一次。

---

## 第 4 步：開啟強制 HTTPS

1. 停在同一個 Pages 設定頁。
2. 找到 **「Enforce HTTPS」**，勾選它。
3. 如果它是灰色、不能勾，旁邊會寫「certificate has not yet been issued」（憑證尚未核發）。這代表 GitHub 還在申請 HTTPS 憑證，通常要 15 分鐘到 1 小時，最久可能 24 小時。期間每隔一陣子重新整理頁面，能勾了再勾。

---

## 第 5 步：重新部署一次

設定網域並不會自動重新建置網站，所以要手動執行一次：

1. 打開 <https://github.com/seeghost1019/open-pose-costume/actions>
2. 點左側的 **「Check and deploy」**。
3. 點右邊的 **「Run workflow」**，Branch 選 `main`，再點綠色的 **「Run workflow」**。
4. 等出現綠色勾勾 ✅，大約 2～5 分鐘。

> 這次建置會偵測到自訂網域，改用根目錄 `/` 建置。

---

## 第 6 步：打開網站確認

1. 打開 **<https://pose.seeghost.win/>**，應該會看到繁體中文的網站。
2. 打開舊網址 <https://seeghost1019.github.io/open-pose-costume/> ，GitHub 應該會自動把你轉到 `pose.seeghost.win`。
3. 用搜尋框試搜「藍色大衣」，確認有結果。

---

## 遇到問題時

| 狀況 | 原因與解法 |
|---|---|
| 畫面一片空白，或圖片、樣式都沒載入 | 還沒做第 5 步，或第 5 步還沒跑完。完成後按 `Ctrl+Shift+R`（Mac 是 `Cmd+Shift+R`）強制重新整理。 |
| 瀏覽器顯示「重新導向次數過多」 | 第 2 步的雲朵變成了橘色。回 Cloudflare 改回灰色（DNS only）。 |
| 瀏覽器顯示連線不安全 | HTTPS 憑證還沒核發。等第 4 步可以勾選後再試。 |
| 一直顯示「DNS check unsuccessful」 | 回第 2 步確認：Name 是 `pose`，Target 是 `seeghost1019.github.io`，雲朵是灰色。 |

---

## 加分步驟（建議做）：驗證網域所有權

這一步可以防止別人把 `seeghost.win` 底下的子網域拿去接到他們的 GitHub 網站。

1. 打開 <https://github.com/settings/pages>（注意：這是**你個人帳號**的設定，不是倉庫的設定）。
2. 點 **「Add a domain」**，填入 `seeghost.win`，再點 **「Add domain」**。
3. GitHub 會給你一筆 **TXT 記錄**，包含一個名稱（`_github-pages-challenge-seeghost1019`）和一串值。
4. 回到 Cloudflare 的 DNS → Records → **「+ Add record」**：
   - Type 選 `TXT`
   - Name 填 GitHub 給的名稱：`_github-pages-challenge-seeghost1019`
   - Content 貼上 GitHub 給的那串值
   - 點 Save
5. 回到 GitHub 點 **「Verify」**。如果還驗證不過，等幾分鐘再點一次。

---

## 之後可以再做的事

- **換掉分享預覽圖**：`public/social/omilic-x-card.png` 是原作者的簡體版，上面印著 omilic.com。
- **改掉原作者的 X 帳號**：`index.html` 裡的 `twitter:site` 還是 `@HongyeMain`。
