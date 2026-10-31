# Quy trình: hàng đợi tài khoản + Chrome profile tạm + proxy + chrome-devtools-mcp

## Kiến trúc

```
UI 127.0.0.1:8788 (Node, không dependency)
  └─ POST /api/queue/start
       └─ mở tối đa N cửa sổ, mỗi tài khoản một profile Chrome tạm:
            --user-data-dir=profiles/acct-<tên>-<hash>
            --remote-debugging-port=9300+   <- chrome-devtools-mcp
            xếp lưới 600x800, scale 80%
            --proxy-server (proxy lấy từ pool theo thứ tự tài khoản)
              ├─ HTTP/HTTPS có auth -> bridge 127.0.0.1:<port> -> proxy
              └─ trống               -> IP máy
  └─ Xong / đóng cửa sổ
       └─ đóng Chrome, xoá profiles/<tên> + mcp/<tên>.json (nếu bật xoá)
            └─ mở tài khoản kế tiếp vào chỗ trống
```

Mỗi profile tạm có: 1 `user-data-dir`, 1 proxy, 1 cổng CDP, 1 entry MCP riêng. Proxy giữ
cố định cho cả phiên của profile (không xoay theo request) để session/login ổn định.

## 0. Yêu cầu

- Node.js 22+ (dùng `WebSocket` có sẵn; đã test với Node 24). Dự án không có thư viện runtime bên ngoài.
- Chrome 142 for Testing tải sẵn trong `vendor/` (khuyến nghị), hoặc Chrome stable cài trên máy.

### 0.1 Cài đặt

Chạy `install.bat` (nhấp đúp) để kiểm tra Node.js 22+, chạy `npm install` và tải Chrome 142 +
ChromeDriver. Có thể chạy tay:

```bash
npm install
npm run setup:chrome142
```

Script tải bản Chrome for Testing 142 mới nhất (hiện `142.0.7444.175`) và ChromeDriver cùng phiên bản, giải nén vào:

```
vendor/chrome-142/chrome-win64/chrome.exe
vendor/chromedriver-142/chromedriver-win64/chromedriver.exe
vendor/chrome-142.json   (manifest: version, đường dẫn, thời điểm tải)
```

- Launcher dùng `chrome.exe` của bản bundled khi `useBundledChrome: true` và `chromePath` để trống.
- `chromedriver.exe` chỉ cần nếu bạn chạy Selenium/WebDriver; quy trình này điều khiển Chrome qua CDP + `chrome-devtools-mcp`.
- Chrome for Testing luôn hiện thanh "Chrome for Testing ... is only for automated testing" — đây là đặc trưng của bản build, không tắt được; không ảnh hưởng thao tác. Muốn sạch UI thì cài Chrome stable mới và trỏ `chromePath` vào đó.

## 1. Cấu hình `profiles.json`

| Trường | Ý nghĩa |
|---|---|
| `teamUrl` | Link team CapCut mở cho mọi profile |
| `chromePath` | Đường dẫn `chrome.exe`; để trống sẽ tự dò |
| `useBundledChrome` | `true` = ưu tiên Chrome 142 trong `vendor/` |
| `uiPort` | Cổng UI local (mặc định `8788`) |
| `profilesDir` | Nơi tạo profile tạm (mặc định `profiles/`) |
| `mcpDir` | Nơi sinh file cấu hình MCP (mặc định `mcp/`) |
| `basePort` | Cổng CDP gốc; cổng trống kế tiếp được cấp cho mỗi profile |
| `concurrency` | Số cửa sổ mở đồng thời (1–20, mặc định 3) |
| `headless` | `true` = mở Chrome ẩn cho hàng đợi |
| `ephemeral` | `true` = xoá profile + MCP sau khi tài khoản xong (mặc định bật) |
| `proxyEnabled` | `true` = dùng pool proxy cho profile mới |
| `proxies` | Danh sách proxy, mỗi phần tử một dòng |
| `window.width` / `window.height` | Kích thước cửa sổ cố định (mặc định 600x800) |
| `window.scale` | Scale nội dung, `0.8` = 80% |
| `window.gap` | Khoảng cách giữa các cửa sổ (px) |
| `window.columns` | `0` = tự động chọn lưới vừa màn hình; >0 = số cột cố định |

Định dạng proxy: `http://user:pass@host:port`, `host:port:user:pass`, `https://...`,
`socks5://host:port` (SOCKS5 không hỗ trợ auth). Proxy HTTP/HTTPS có auth được bridge local
tự thêm user/pass vì Chrome không tự gửi. **Lưu ý:** danh sách proxy lưu trong `profiles.json`
có thể chứa thông tin đăng nhập proxy — không chia sẻ file này.

## 2. Chạy bằng UI

```bat
start.bat
```

Hoặc `npm run ui`. `start.bat` mở server và tự mở trình duyệt tới `http://127.0.0.1:8788`.
UI chỉ bind loopback, gồm 3 tab:

- **Tài khoản** (mặc định): link team, danh sách `email | mật khẩu`, số luồng, headless,
  bật/tắt xoá profile, chạy hàng đợi và mục **Dữ liệu chạy** — bảng kết quả có menu lọc
  **Tất cả / Thành công / Lỗi / Chờ chạy lại** kèm số lượng, bấm menu để xem danh sách tương ứng.
- **Proxy**: bật/tắt proxy và dán pool proxy cho các profile mới; lưu bằng **Lưu proxy**.
- **Cấu hình**: Chrome bundled / `chromePath`, kích thước cửa sổ, scale %, khoảng cách, số cột;
  preview lưới theo màn hình thật. Sửa xong bấm **Lưu cấu hình**.

### Hàng đợi tài khoản

Dán danh sách vào textarea, mỗi dòng một tài khoản:

```text
account1@example.com | matkhau1
account2@example.com | matkhau2
```

- Dòng trống, dòng bắt đầu bằng `#` hoặc `//` bị bỏ qua.
- Tách email và mật khẩu bằng `|` hoặc tab. Phần sau dấu `|` đầu tiên là mật khẩu (giữ nguyên cả ký tự `|` nếu có).
- Dòng sai định dạng hoặc trùng email sẽ chặn chạy và báo số dòng.

Sau khi bấm **Chạy hàng đợi**:

1. Server mở tối đa `Số luồng` cửa sổ; mỗi tài khoản vào link team, xếp lưới theo cấu hình.
2. Proxy được gán lần lượt theo thứ tự tài khoản; hết danh sách thì quay vòng. Pool trống hoặc
   tắt proxy thì profile đi bằng IP máy.
3. Khi đăng nhập/join team xong, bấm **Xong** trên dòng đó (hoặc đóng cửa sổ Chrome). Server đóng
   Chrome, xoá `profiles/<tên>` và `mcp/<tên>.json` nếu bật **Xoá profile sau khi xong**, rồi mở
   tài khoản kế tiếp vào chỗ trống.
4. **Dừng nhận tài khoản mới** giữ các cửa sổ đang chạy nhưng không mở thêm.
5. **Đóng cửa sổ hàng đợi** dừng hàng đợi, đóng mọi cửa sổ và dọn profile tạm.
6. **Copy MCP** trên dòng đang chạy để lấy cấu hình MCP của đúng profile đó.

Mục **Dữ liệu chạy** chia kết quả thành các menu (bấm để xem danh sách, số trong ngoặc là số lượng):

- **Thành công**: flow đã vào `capcut.com/my-cloud/`, hoặc tài khoản bị bỏ qua vì đã hoàn tất ở lần
  chạy trước (trạng thái *Đã xong trước*).
- **Lỗi**: flow dừng vì OTP/captcha, hết thời gian chờ hoặc lỗi khác; Chrome vẫn mở để xử lý thủ công.
- **Chờ chạy lại**: tài khoản gặp `JoinErrPanelTitle-GWfMxQ` (*Can’t submit request*), Chrome đã đóng
  và sẽ được chạy lại ở lần nhập danh sách sau.
- **Tất cả**: toàn bộ tài khoản của lần chạy hiện tại, gồm cả dòng đang chờ/đang chạy/đã đóng.

Danh sách kết quả chỉ sống trong phiên server hiện tại (khởi động lại thì trống). Lịch sử hoàn tất
trong `data/completed.json` chỉ lưu hash SHA-256 của email, không lưu email/mật khẩu.

### Đăng nhập tự động (CDP)

Sau khi profile mở link team, server tự điều khiển tab qua CDP:

1. Chờ phần tử `span.lv_third_part_sign_in_expand-label` có chữ **Continue with email**, bấm vào.
2. Chờ `input[name="username"]`, điền email, bấm nút **Continue**
   (`button.lv_email_entry_view-btn`).
3. Chờ `input[name="password"]`, điền mật khẩu, bấm **Sign in**
   (`button.lv_sign_in_panel_wide-sign-in-button`).
4. Chờ form **Join space** (`.JoinPanel-Y4S5YH`) và bấm **Submit** (`.JoinPanelBtn-Ffvlan`).
5. Sau Submit, chờ tab chuyển tới URL chứa `https://www.capcut.com/my-cloud/` (tối đa 60 giây).
   Phần id và query phía sau tùy từng tài khoản, chỉ cần đúng tiền tố này. Chỉ khi thấy URL đó mới
   in log `THÀNH CÔNG: đã vào my-cloud (...)` và đánh dấu dòng hàng đợi màu xanh. Nếu trang báo
   “Can’t join space”, flow bấm **OK** rồi tiếp tục chờ; hết thời gian mới báo lỗi.
   Nếu gặp panel `JoinErrPanelTitle-GWfMxQ` (“Can’t submit request”), tài khoản được đánh dấu
   **Chờ chạy lại** (không ghi lịch sử), Chrome đóng và profile tạm bị xoá; lần chạy sau nhập lại
   danh sách, tài khoản này sẽ được chạy tiếp vì chưa có trong lịch sử.
6. Nếu bật **Xoá profile sau khi xong**, sau khoảng 2 giây server tự đóng Chrome, xoá profile + MCP
   và mở tài khoản kế tiếp. Tắt tuỳ chọn này thì cửa sổ giữ nguyên để kiểm tra, bấm **Xong** khi xong.

- Tiến trình từng bước hiện ngay trong cột trạng thái; lỗi hiện màu đỏ, Chrome vẫn mở để xử lý thủ công.
- Nếu CapCut yêu cầu OTP/mã xác minh hoặc captcha, flow dừng và báo lỗi — không tự vượt qua.
- Nếu tài khoản đã đăng nhập sẵn và form Join space hiện ngay, flow bấm Submit luôn. Nếu tab đã ở
  `capcut.com/my-cloud/` từ đầu, flow ghi nhận thành công ngay.
- Chrome của profile tạm được tắt hộp thoại lưu mật khẩu (`credentials_enable_service=false`,
  `--disable-save-password-bubble`), nên không còn popup “Lưu mật khẩu?”.
- Mật khẩu chỉ nằm trong RAM; được xoá ngay khi flow kết thúc (thành công hoặc lỗi).
- Trang CapCut đổi giao diện có thể làm selector lệch; khi đó cập nhật selector trong `src/flow.js`.

### Bỏ qua tài khoản đã hoàn tất

- Khi flow thành công, server lưu **hash SHA-256** của email (chuẩn hoá chữ thường) vào
  `data/completed.json` kèm thời điểm. File không chứa email gốc hay mật khẩu và bị loại khỏi Git.
- Lần chạy sau, tài khoản đã có trong lịch sử được đánh dấu **Đã xong trước**, không mở Chrome,
  không chiếm luồng. Tài khoản lỗi/chưa chạy sẽ được chạy lại bình thường.
- Nếu nhập trùng một tài khoản đã xong, hàng đợi chỉ mở các tài khoản còn lại; nếu tất cả đã xong,
  UI báo “Tất cả tài khoản đã hoàn tất trước đó”.
- Nút **Xoá lịch sử hoàn tất** (dưới bảng hàng đợi) xoá `data/completed.json` để chạy lại toàn bộ.

Profile được đặt tên `acct-<tên>-<hash>`, dùng một lần rồi xoá — **không lưu phiên đăng nhập**.
Mật khẩu chỉ nằm trong RAM của tiến trình UI và bị xoá khi tài khoản kết thúc; **không** ghi vào
`profiles.json`, status API hay file MCP. Khởi động lại UI là phải dán lại danh sách.

Headless: Chrome chạy `--headless=new`, không có cửa sổ để xem; dùng MCP/agent để thao tác, hoặc
tắt headless khi cần đăng nhập thủ công. CapCut có thể chặn headless/captcha — khi đó dùng chế độ
có cửa sổ.

### Cách xếp cửa sổ

- Mỗi cửa sổ dùng `width x height` làm kích thước mong muốn (mặc định 600x800), `scale` nội dung 80%.
- Vị trí/kích thước tính theo DIP (đơn vị Chrome dùng cho `Browser.setWindowBounds`), quy đổi từ
  vùng làm việc vật lý: `DIP = pixel vật lý / scale`. Ví dụ màn hình 1920x1040, scale 0.8 → vùng đặt
  cửa sổ 2400x1300 DIP.
- Server tự chọn số cột/hàng sao cho toàn bộ lưới nằm trong vùng làm việc (đã trừ taskbar) và canh
  giữa. Không còn dồn hàng xuống đè lên hàng trên.
- Nếu `width x height` không đủ chỗ, cửa sổ được thu nhỏ theo lưới nhưng không xuống dưới 520x200 DIP
  (mức tối thiểu Chrome chịu được). Số cửa sổ quá nhiều so với màn hình sẽ chọn lưới thưa hơn.
- Muốn cố định số cột, đặt `window.columns > 0`. Vị trí thực tế vẫn được ép lại qua CDP
  `Browser.setWindowBounds` sau khi Chrome mở.
- Scale 80% làm nội dung 600x800 hiển thị như 750x1000 CSS px — đủ rộng cho form đăng nhập CapCut.

## 3. Nối chrome-devtools-mcp

File `mcp/<tên>.json` sinh ra khi profile mở, dạng:

```json
{
  "mcpServers": {
    "chrome-devtools-acct-abc-example-1a2b3c": {
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@latest",
        "--browserUrl",
        "http://127.0.0.1:9300",
        "--no-usage-statistics"
      ]
    }
  }
}
```

Bấm **Copy MCP** ở dòng tương ứng, dán vào cấu hình MCP của Qoder (Settings → MCP) rồi mở chat mới.
Mỗi profile cần một entry riêng vì một server MCP chỉ gắn với một browser. File MCP bị xoá cùng
profile khi tài khoản xong.

## 4. Quy trình đăng nhập + vào link team

Prompt mẫu cho agent (thay tên MCP/link nếu cần):

```text
Dùng MCP server chrome-devtools-<tên profile>.

1. take_snapshot để xem trang hiện tại.
2. Nếu có form đăng nhập: điền email của tài khoản vào ô email/username rồi bấm Continue/Next.
   KHÔNG tự nhập mật khẩu hay OTP. Dừng lại để tôi nhập thủ công.
3. Sau khi đăng nhập xong, take_snapshot, tìm nút Join/Accept/Tham gia team và bấm.
4. take_screenshot để xác nhận kết quả.
```

- Đăng nhập thủ công (mật khẩu/2FA) trong cửa sổ Chrome; profile chỉ sống trong phiên hiện tại.
- Kiểm tra proxy: mở `https://ipinfo.io/json` trong profile. Proxy trống sẽ ra IP máy; có proxy sẽ ra IP proxy.
- CapCut đổi giao diện: ưu tiên `take_snapshot` (accessibility tree) thay vì selector cứng.

## 5. Bảo mật và điều kiện dùng

- Không lưu mật khẩu trong `profiles.json`: danh sách tài khoản của hàng đợi chỉ nằm trong RAM tiến trình UI, status API chỉ trả email.
- Profile là tạm: bật **Xoá profile sau khi xong** để Chrome + dữ liệu phiên bị xoá ngay sau khi tài khoản kết thúc.
- UI chỉ bind `127.0.0.1`; không mở cổng ra LAN. Máy dùng chung nên tránh dán mật khẩu khi người khác có quyền xem màn hình/tiến trình.
- Cổng debugging cho phép ứng dụng trên máy điều khiển Chrome; chỉ mở khi đang dùng.
- Chỉ dùng với tài khoản bạn sở hữu hoặc được ủy quyền. Không dùng để tạo/đăng nhập hàng loạt tài khoản, vượt captcha/2FA hay lách giới hạn của CapCut — vi phạm ToS có thể bị khóa tài khoản.

## 6. Xử lý lỗi

| Lỗi | Cách xử lý |
|---|---|
| Chrome thoát ngay / không mở CDP | Profile đang bị Chrome khác dùng. Đóng cửa sổ Chrome liên quan rồi chạy lại; profile tạm sẽ được tạo lại. |
| `Không tìm thấy chrome.exe` | Chạy `npm run setup:chrome142`, hoặc điền `chromePath` trong UI/`profiles.json`. |
| Cửa sổ sai kích thước/vị trí | Bấm **Lưu cấu hình** rồi chạy lại; launcher ép lại bounds qua CDP. Kiểm tra `window.columns` không quá lớn. |
| Thanh "Chrome for Testing ... automated testing" | Đặc trưng của Chrome for Testing, không tắt được; dùng Chrome stable nếu cần UI sạch. |
| `Hàng đợi đang chạy` (409) | Bấm **Dừng nhận tài khoản mới** hoặc **Đóng cửa sổ hàng đợi** trước khi chạy danh sách mới. |
| Báo lỗi dòng khi chạy hàng đợi | Kiểm tra đúng dạng `email | mật khẩu`; xoá dòng trùng hoặc email sai. |
| Headless không vào được link/CapCut chặn | Tắt headless để đăng nhập có cửa sổ; headless dễ bị captcha/anti-bot hơn. |
| Flow báo `Hết thời gian chờ trang đăng nhập` | Kiểm tra link team, mạng và proxy; thử tắt headless để xem trang thực tế. |
| Flow báo yêu cầu OTP/captcha | Xử lý thủ công trong cửa sổ Chrome rồi bấm Xong; flow không vượt xác minh. |
| Flow báo `Không tìm thấy nút ...` | CapCut đổi giao diện; cập nhật selector trong `src/flow.js`. |
| Flow báo `Đã bấm Submit nhưng chưa chuyển về my-cloud` | Submit chưa được chấp nhận hoặc CapCut đổi URL đích; mở cửa sổ kiểm tra thủ công rồi chạy lại tài khoản đó. |
| Flow báo `CapCut báo "Can’t join space" và chưa chuyển về my-cloud` | Flow đã bấm OK nhưng tab không vào my-cloud trong 60 giây. Kiểm tra cửa sổ Chrome còn mở, xử lý thủ công rồi chạy lại tài khoản. |
| Dòng hiện `Chờ chạy lại` / `Tài khoản chưa join được` | CapCut trả panel `Can’t submit request`. Tài khoản không được ghi lịch sử và sẽ chạy lại ở lần chạy hàng đợi kế tiếp. |
| Đóng cửa sổ mà không mở tài khoản kế tiếp | Hàng đợi đã dừng hoặc đã hết danh sách; xem cột trạng thái. |
| Profile không bị xoá | Windows còn giữ file; server thử lại vài lần. Xem ghi chú lỗi ở cột trạng thái; đóng Chrome rồi xoá thủ công nếu cần. |
| Proxy không hoạt động | Kiểm tra host/port/user/pass; xem log bridge; thử `ipinfo.io`. |
| SOCKS5 có auth bị từ chối | Đổi sang proxy HTTP/HTTPS. |
| MCP không thấy browser | Kiểm tra `browserUrl` trùng cổng CDP của dòng đang chạy; mở `http://127.0.0.1:<port>/json/version` để test. |
| Cổng bị chiếm | Tăng `basePort` trong `profiles.json`. |
