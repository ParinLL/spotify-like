# Spotify Like Action Button

一個 Cloudflare Worker：一鍵把 Spotify 目前播放的歌曲（或 podcast 單集）加入「已收藏的歌曲」，並用中文通知回報結果。觸發方式不限於 iPhone 動作按鈕——任何能執行 iOS 捷徑的入口都可以，詳見下方「觸發方式」。詳細需求與設計請見
`.kiro/specs/spotify-like-action-button/`。

本文件是一次性設定流程：註冊 Spotify 應用程式、取得 refresh token、部署 Worker，
以及設定捷徑（Shortcut）。

## 使用的 Spotify API

只使用 **Web API**（REST 端點：token 交換、目前播放狀態、收藏庫寫入）。
不使用 Ads API、Web Playback SDK、iOS SDK 或 Android SDK。

## 事前準備

- 一個 Spotify 帳號，按鈕會修改該帳號的收藏庫。**需要 Premium** —
  見 [Development Mode 的限制](#development-mode-的限制)。
- 已安裝 Node.js 並取得本專案原始碼（`npm install`）。
- 已登入 Cloudflare 帳號的 Wrangler CLI（`npx wrangler login`）。
- 一支安裝捷徑 App 的 iPhone。不需要動作按鈕——那只是其中一種觸發方式（見步驟 5）。

## 1. 註冊 Spotify 應用程式

1. 前往 [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)，用要被此按鈕修改收藏庫的帳號登入。
2. 點擊 **Create app**，填入名稱與描述（隨意即可，這個 app 不會公開）。
3. 在 **Redirect URI** 加入 `http://127.0.0.1:8787/callback` 並儲存。這個網址只在下方的一次性授權步驟中使用，之後可以移除。
4. 打開 app 的 **Settings**，記下 **Client ID** 與 **Client Secret**，下一步會用到。

## 2. 取得 refresh token

這是 OAuth authorization-code 交換流程，只請求兩個授權範圍（scope）— 剛好是 Worker
實際會用到的，沒有多要：

| Scope | 用途 |
|---|---|
| `user-read-currently-playing` | `GET /me/player/currently-playing` |
| `user-library-modify` | `PUT /me/library`（歌曲與 podcast 單集都靠它） |

早期版本多請求了兩個。`user-read-playback-state` 沒有任何程式碼路徑在用 — 它對應的是
`GET /me/player` 和 `/me/player/devices`，這個 Worker 都不呼叫，而且還會額外向使用者索取
Spotify Connect 裝置資訊的存取權。`user-library-read` 原本用來支撐一個「是否已收藏」的查詢，
那個查詢已經移除，因為 `PUT /me/library` 本身是 idempotent，先查也不會改變要不要送出。

授權範圍事後要擴大確實得重跑這個流程 — 但為了 refresh token，你本來就至少每 6 個月要重跑一次，
所以沒有理由現在先多要。

### 方法 A：使用輔助腳本（建議）

```bash
SPOTIFY_CLIENT_ID=<你的 client id> SPOTIFY_CLIENT_SECRET=<你的 client secret> \
  npx tsx scripts/get-refresh-token.ts
```

或用參數代替環境變數：

```bash
npx tsx scripts/get-refresh-token.ts --client-id=<你的 client id> --client-secret=<你的 client secret>
```

腳本會把授權網址印到 stderr，並在 `127.0.0.1:8787` 啟動一個本機監聽器等待。
用**目標 Spotify 帳號登入的瀏覽器**打開該網址，同意授權後，腳本會自動用收到的
code 換取 token。refresh token 會印到 stdout — 複製下來即可，過程中不會寫入任何檔案。

### 方法 B：手動 curl 流程

1. 用目標帳號登入的瀏覽器打開下列網址（填入 `<CLIENT_ID>`）：

   ```
   https://accounts.spotify.com/authorize?client_id=<CLIENT_ID>&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Fcallback&scope=user-read-currently-playing%20user-library-modify
   ```

2. 同意授權後，瀏覽器會被導向 `http://127.0.0.1:8787/callback?code=<AUTH_CODE>`（因為沒有任何服務在監聽，畫面會顯示無法連線，這是正常的，直接從網址列複製 `<AUTH_CODE>` 即可）。
3. 在幾分鐘內（code 是一次性且短效的）用它換取 token：

   ```bash
   curl -X POST https://accounts.spotify.com/api/token \
     -u "<CLIENT_ID>:<CLIENT_SECRET>" \
     -d grant_type=authorization_code \
     -d code=<AUTH_CODE> \
     -d redirect_uri=http://127.0.0.1:8787/callback
   ```

4. 從回應 JSON 中複製 `refresh_token` 欄位。`access_token` 可以捨棄，因為 Worker 每次都會自己重新取得。

> [!IMPORTANT]
> **refresh token 會在你授權後 6 個月過期**，所以這個步驟不是一次性的 —
> 至少每 6 個月要重做一次。
>
> 計時從授權那一刻開始，而且**重新整理 token 不會延長它**：依照
> [Spotify 官方文件](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens)，
> 這個期限是從原始授權算起，不是從最後一次 refresh 算起。這是 Spotify
> [2026 年 6 月才加上的限制](https://developer.spotify.com/blog/2026-06-18-refresh-token-expiration)，
> 以前的 refresh token 是不會過期的。內容已改寫以符合授權規範。
>
> 過期時 token 端點會回 `400 invalid_grant`，通知會顯示
> `Spotify 授權已失效，請重新取得授權`。復原步驟見
> [每 6 個月重新授權](#每-6-個月重新授權) — 注意需要**兩個**指令，不是一個。

## 3. 建立 token 更新用的 KV 命名空間

Worker 會把 Spotify 發出的新 refresh token 存進一個 Cloudflare Workers KV
命名空間（`TOKEN_KV`），而不是直接丟棄，這樣即使 Spotify 在背後更新了
refresh token，按鈕也能繼續正常運作。

這解決的是 Spotify 在效期內「換發」token 的情況，**不會**延長那 6 個月的授權期限 —
換發的新 token 繼承的是同一個到期時間，因為那個期限綁在原始授權上。換發和過期
是兩件不同的事。

第一次真正部署之前，先建立這個命名空間：

```bash
npx wrangler kv namespace create spotify-like-token-store
```

這會印出一個 id。把它填入 `wrangler.toml` 中既有的 `[[kv_namespaces]]`
區塊的 `id` 欄位（取代 `REPLACE_WITH_REAL_KV_NAMESPACE_ID` 這個佔位值）：

```toml
[[kv_namespaces]]
binding = "TOKEN_KV"
id = "<上面印出的 id>"
```

不需要用 `wrangler kv key put` 手動塞值進去 — 第一次部署時 KV
命名空間是空的，Worker 會直接改用下一步設定的 `SPOTIFY_REFRESH_TOKEN`，
行為跟原本的基礎功能完全一樣，直到 Spotify 自己發出新的 token 為止。

## 4. 部署 Worker

依序設定四個 secret（`wrangler secret put` 會提示輸入，值不會留在 shell 歷史紀錄中）：

```bash
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler secret put SPOTIFY_REFRESH_TOKEN
npx wrangler secret put SHORTCUT_SECRET      # 例如用: openssl rand -base64 32 產生
```

### 通知語言

通知**預設是英文**。要改成繁體中文，在 `wrangler.toml` 設定 `MESSAGE_LANGUAGE`：

```toml
[vars]
MESSAGE_LANGUAGE = "zh_TW"   # "en"（預設）或 "zh_TW"
```

這是一般的 var 而不是 secret，所以放在 `wrangler.toml`，不用 `wrangler secret put`。
只接受 `en` 和 `zh_TW` 兩個值，而且必須完全一致 — `zh-TW`、`zh_tw`、`EN` 都會被拒絕。
填了無法識別的值時，Worker 會對所有請求回 `misconfigured`，而不是默默退回預設值，
這樣打錯字看得出來，不會安靜地用錯語言回你。整個不寫這個 var 也可以，就是英文。

然後部署：

```bash
npx wrangler deploy
```

記下 Wrangler 印出的 Worker 網址（`https://<worker-name>.<subdomain>.workers.dev`），設定捷徑時會用到。

### 本機開發

把 `.dev.vars.example` 複製成 `.dev.vars`，填入相同的四個值（此檔案已加入
`.gitignore`，不會被提交）：

```bash
cp .dev.vars.example .dev.vars
# 編輯 .dev.vars，填入 SPOTIFY_CLIENT_ID、SPOTIFY_CLIENT_SECRET、
# SPOTIFY_REFRESH_TOKEN、SHORTCUT_SECRET
npx wrangler dev
```

本機開發時 `MESSAGE_LANGUAGE` 同樣是從 `wrangler.toml` 讀，不是從 `.dev.vars` —
它是 var，不是 secret。

`wrangler dev` 會自動讀取 `.dev.vars`，並在 `http://127.0.0.1:8787`
提供服務。本機開發也不需要額外設定 KV — `wrangler dev` 會根據
`wrangler.toml` 裡宣告的 `TOKEN_KV` 綁定，自動在本機建立一份磁碟模擬版的
KV 命名空間，不需要真實的 Cloudflare KV 命名空間 id。

## 5. 設定捷徑（Shortcut）

在 iOS 捷徑 App 中建立一個新捷徑，依序加入**三個**動作：

1. **取得 URL 內容（Get Contents of URL）**
   - URL：`https://<worker-name>.<subdomain>.workers.dev/like`
   - 方式：`POST`
   - 標頭（Headers）：新增一個 — 鍵值 `Authorization`，值 `Bearer <SHORTCUT_SECRET>`
     （`Bearer` 後面有一個半形空格；值與步驟 4 設定的相同）
   - 要求內文：**無**（不要留在預設的 JSON）
2. **取得字典值（Get Dictionary Value）**
   - 取得：`值`
   - 鍵值：`message`
   - 來源會自動接上前一個動作的結果
3. **顯示通知（Show Notification）**
   - 內容：選用上一步的**字典值**變數（不是整包「URL 內容」，否則通知會顯示原始 JSON）
   - 標題：留空
   - 附件：**清空**（若自動填入了「URL 內容」要移除，否則會多夾一份 JSON 附件）

少了第 2 個動作，通知會直接顯示整串
`{"message":"...","ok":true,"outcome":"added",...}`，而不是那句中文訊息。

### 觸發方式（任選，不必用動作按鈕）

重點是「能快速執行這個捷徑」，用哪個入口都行。動作按鈕只是最順手的一種：

| 觸發方式 | 設定位置 | 備註 |
|---|---|---|
| **iPhone 動作按鈕** | 設定 → 動作按鈕 → 捷徑 | 需 iPhone 15 Pro 以上 |
| **Apple Watch Ultra 動作按鈕** | 錶上「設定 → 動作按鈕 → 捷徑」，或 iPhone 的 Watch App → 動作按鈕 | Ultra / Ultra 2。聽歌時手腕一按最直覺 |
| **控制中心** | 控制中心編輯 → 加入「捷徑」控制項 | iOS 18 以上 |
| **鎖定畫面 / 主畫面** | 捷徑 App 長按該捷徑 → 加到主畫面；或鎖定畫面加捷徑小工具 | 全機型可用 |
| **背面輕點** | 設定 → 輔助使用 → 觸控 → 背面輕點 → 輕點兩下/三下 | 全機型可用，不占按鈕 |
| **Siri** | 直接喊捷徑名稱（例如「Spotify-like」） | 也可在 Apple Watch / AirPods 上喊 |
| **Apple Watch 捷徑 App** | 錶上開啟捷徑 App 直接點；或做成錶面複雜功能 | 不限 Ultra |

Apple Watch 上執行沒問題——這個捷徑只用到「取得 URL 內容」，watchOS 支援，
錶有 LTE 或 Wi-Fi 時可獨立執行，否則會透過配對的 iPhone 連線。

（專案名稱裡的 "action-button" 只是最初的使用情境，不是限制條件。）

## 6. 驗證

播放中觸發這個捷徑（用上面任一種方式），預期會看到：

```
已加入喜愛：<歌名> - <歌手>
```

（`MESSAGE_LANGUAGE = "en"` 時是 `Liked: <name> - <artist>`）

也可以換幾種播放狀態試試，確認四種結果都正確：

| 播放中的內容 | 預期通知（`zh_TW`） | 預期通知（`en`） |
|---|---|---|
| 一般歌曲 | `已加入喜愛：<歌名> - <歌手>` | `Liked: <name> - <artist>` |
| Podcast 單集 | `已加入喜愛：<節目名稱> - <單集標題>` | `Liked: <show> - <title>` |
| 完全沒播放 | `目前沒有播放中的歌曲` | `Nothing is playing` |
| 本機檔案（local file） | `目前播放的內容無法加入喜愛` | `This item can't be added to your library` |

本機檔案是唯一預期會出現「無法加入喜愛」的情況。Podcast 可以正常加入。

如果 podcast 出現「無法加入喜愛」，那是 bug，請回報而不是重試。唯一已知的原因是
Worker 在呼叫 currently-playing 時漏了 `additional_types=track,episode` 參數：少了它，
Spotify 對**所有**單集都會回 `item: null`，於是沒有 id 可以收藏
（[spotify/web-api#1496](https://github.com/spotify/web-api/issues/1496)）。
現在這個參數已經帶上，所以沒有已知的觸發條件了 — 這份 README 之前把它寫成
Spotify 端的偶發狀況，那是把我們自己漏參數的問題誤判到 Spotify 身上。

### 訊息長度

**名稱**（歌名、單集標題）一律完整顯示。只有**作者**（歌手、節目名稱）會被截斷，上限
**28 個欄寬**，超過就在尾端加上 `…`。

這樣做的原因是 iOS 通知**從尾巴截斷**：不限制作者長度的話，長節目名稱會把整個單集標題擠出畫面。
改成只截作者，萬一還是被 iOS 切掉，被切掉的也是次要欄位，而不是你真正想辨認的那個名稱。

欄寬而非字數：中日韓是全角字算 2 欄，英數算 1 欄，所以 28 欄約等於 14 個中文字或 28 個英文字元，
兩種文字的視覺長度一致 — 兩種通知語言也共用同一個上限。通知橫幅一行大約 38-40 欄、共兩行，
前綴（`已加入喜愛：` 是 12 欄、`Liked: ` 是 7 欄）＋作者 28 欄＋` - `（3 欄）之後，第二行
大部分仍留給名稱。

```
已加入喜愛：珞亦不絕 by 法律白話文 Plain… - 154｜遲到、擺爛、不夠完美 ft. yoyo
已加入喜愛：Bohemian Rhapsody - Queen
```

截斷只影響 `message` 這個欄位，回應 JSON 裡的 `track` / `episode` 仍是完整未截斷的值。

**如果 iOS 顯示的是一般性的「執行失敗」/「無法執行捷徑」對話框，而不是中文通知**，代表
`Authorization` 標頭設錯了 — 檢查捷徑標頭中的 `SHORTCUT_SECRET` 是否與
`wrangler secret put SHORTCUT_SECRET` 設定的值完全一致。這是唯一一種 Worker 會回傳非 200
狀態碼的情況，其他所有失敗（Spotify 服務中斷、Spotify 授權過期、網路問題）都仍會被
`顯示通知` 動作讀到，並顯示可理解的訊息。

## Development Mode 的限制

像這樣的個人 app 會一直留在 Spotify 的 **Development Mode**（Extended Quota Mode 是給
服務大量使用者的 app 用的）。自 Spotify
[2026 年 2 月的變更](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
起，這個模式有幾個限制值得先知道，免得把時間花在查別的地方：

- **App 擁有者必須有有效的 Spotify Premium 訂閱。** 訂閱失效 app 就會停止運作，重新訂閱
  之後會恢復。這是唯一一種沒有專屬通知訊息的失敗原因 — 它會表現成
  `操作未完成，請稍後再試`（`api_failed`）或是授權相關訊息，兩者都不會指向帳單問題。
  所以如果按鈕突然壞掉而你什麼都沒改，先去檢查訂閱狀態。
- **每位開發者 1 個 Client ID**、**每個 app 5 個使用者**。個人使用完全夠。已經超過的舊
  app 會被沿用不受影響。
- Development Mode 的 rate limit 比 Extended Quota Mode 低。這裡不構成問題：按一次最多
  花 3 次 API 呼叫，而額度是
  [30 秒滾動視窗](https://developer.spotify.com/documentation/web-api/concepts/rate-limits)計算的。

內容已改寫以符合授權規範。

## 每 6 個月重新授權

當通知顯示 `Spotify 授權已失效，請重新取得授權` 時，代表那 6 個月的 refresh token
效期到了。重做步驟 2 取得新的 refresh token，然後**兩個指令都要執行**：

```bash
npx wrangler secret put SPOTIFY_REFRESH_TOKEN          # 填入新的 token
npx wrangler kv key delete refresh_token --binding TOKEN_KV --remote
```

第二個指令是最容易漏掉的一步。Worker 讀取 refresh token 時，KV 裡存的換發值
優先於 `SPOTIFY_REFRESH_TOKEN` secret，所以只要過期的舊值還在 KV 裡就會繼續
勝出、Worker 也會繼續失敗 — 只更新 secret 完全沒有用。把那個 key 刪掉，Worker
才會退回你剛設定的 secret，之後下一次換發會重新寫回 KV。

確認方式：按一下捷徑，成功加入就表示新授權生效了。

## 更換或撤銷授權

- **更換捷徑密鑰：** 重新執行 `wrangler secret put SHORTCUT_SECRET` 設定新值，再更新捷徑中的標頭。
- **撤銷 Spotify 授權：** 到 [Spotify 帳號授權應用程式清單](https://www.spotify.com/account/apps/) 移除該 app 的授權。之後要重新啟用，照
  [每 6 個月重新授權](#每-6-個月重新授權) 的步驟做 — 包含刪除 KV 的那一步。
