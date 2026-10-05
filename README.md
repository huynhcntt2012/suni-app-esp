# PawMeal — ESP32 + MG996R quét qua lại theo thời gian

Web app tiếng Việt quản lý nhiều thiết bị/tài khoản, lịch theo ngày/giờ, cho ăn thủ công, cấu hình lượng ăn, mã kết nối riêng và nhật ký. Firmware ghép thuật toán test của bạn: quét qua lại từng bước 5 mỗi 5 ms, nghỉ ở hai đầu, chạy trong tổng thời gian API yêu cầu rồi về A và dừng.

## Chạy web

Cài Node.js 24 trở lên, không cần cài thư viện npm:

```powershell
cd 'D:\AI Agent\ESP'
node server.mjs
```

Mở http://localhost:3000, đăng ký và thêm thiết bị. Lưu mã hiển thị một lần vào DEVICE_TOKEN; mỗi ESP32 dùng mã riêng. Điện thoại cùng mạng dùng IPv4 của máy chủ, ví dụ http://192.168.1.10:3000. Đây cũng là SERVER_URL của ESP32; không dùng localhost. Có thể cần cho Node.js qua Windows Firewall trên mạng Private.

Máy chủ phải bật liên tục, không ngủ, đồng hồ đúng. Dữ liệu nằm trong data/feeder.sqlite; giữ data khi khởi động lại. Sao lưu khi đã dừng máy chủ hoặc dùng SQLite backup khi đang chạy. Không công khai data/config.h. Mật khẩu dùng scrypt, phiên dùng cookie HttpOnly, token thiết bị lưu dạng SHA-256. Chưa có khôi phục mật khẩu/xác thực email.

## Đấu dây

| ESP32 / nguồn | Servo |
|---|---|
| GPIO 18 | Tín hiệu, thường cam/vàng |
| GND ESP32 và âm nguồn servo | GND, thường nâu/đen |
| Dương nguồn ngoài phù hợp servo | VCC, thường đỏ |

**Nối chung GND. Không cấp servo từ chân 3V3.** ESP32 có thể cấp USB; servo dùng nguồn ngoài đủ dòng theo sản phẩm thực tế. Không nối dương nguồn ngoài vào đường USB/5V board khi chưa kiểm tra mạch cấp nguồn. Đối chiếu màu dây và khả năng nhận tín hiệu 3,3 V. [MG996R TowerPro](https://towerpro.com.tw/product/mg996R/) ghi điện áp 4,8–6,6 V; kiểm tra thông số chiếc servo đang dùng.

## Nạp firmware

1. Arduino IDE: cài esp32 by Espressif Systems 3.x, chọn ESP32 Dev Module.
2. Cài ArduinoJson 7.x. Không cần ESP32Servo; mã dùng LEDC.
3. Mở firmware/PetFeeder/PetFeeder.ino.
4. Nếu chưa có, sao chép config.example.h thành config.h, điền Wi-Fi 2,4 GHz, SERVER_URL, DEVICE_TOKEN và mật khẩu OTA riêng. **Giữ config.h hiện có** nếu thông tin vẫn đúng.
5. SERVO_PIN mặc định 18. INITIAL_STOP_US từ cấu hình cũ không còn sử dụng.
6. Nạp mã; Serial Monitor 115200 baud.

**Tự nạp PetFeeder.ino mới một lần**, giữ cùng thư mục với TimedSweep.h và config.h. Firmware protocol 1/2/3 cũ không nhận lệnh mới. Bản quét theo thời gian dùng protocol 4, lưu NVS và xác nhận đúng cấu hình trước khi web cho phép cho ăn. Nếu đang chạy test.ino, chọn cổng pawmeal-test-... để nạp; sau đó cổng trở lại pawmeal-.... Bản ghép không tự chạy test vô hạn khi khởi động.

### ArduinoOTA qua Wi-Fi

ArduinoOTA có sẵn trong board package. Nếu bản đang chạy đã có OTA và phân vùng phù hợp, có thể cập nhật qua mạng; nếu chưa có cần USB lần đầu.

- Đặt OTA_PASSWORD riêng ít nhất 8 ký tự, không dùng giá trị mẫu. Giữ mật khẩu đang dùng nếu không muốn đổi.
- Chọn đúng Flash Size và Partition Scheme **có OTA**. Với board 4 MB có thể dùng Minimal SPIFFS (1.9MB APP with OTA/190KB SPIFFS). Đổi bảng phân vùng cần USB.
- Máy tính và ESP32 cùng LAN liên lạc được. Serial in `OTA: pawmeal-<MAC> at <IP>, port 3232`.
- Arduino IDE → Tools → Port: chọn cổng mạng pawmeal-..., Upload, nhập mật khẩu của firmware **đang chạy**. Khi đổi mật khẩu trong bản mới, lần chuyển đổi vẫn dùng mật khẩu cũ.
- Tạm tắt lịch, đợi hoàn tất chu kỳ rồi Upload. OTA chỉ được phục vụ khi máy rảnh; chu kỳ có thể dài tới 60 giây. Firmware giữ tín hiệu góc đóng khi cập nhật. Không ngắt nguồn lúc ghi firmware.
- Không thấy cổng: kiểm tra LAN, mDNS UDP 5353, firewall cho IDE/công cụ upload trên mạng Private. ArduinoOTA nhận UDP 3232 rồi kết nối TCP ngược tới trình upload; chỉ mở TCP 3232 không đủ. Lỗi Wi-Fi/mất OTA có thể phục hồi bằng USB.

OTA không cần web đang chạy, nhưng cần Wi-Fi. Chưa có OTA từ trang web. Chỉ dùng trong mạng riêng tin cậy, không mở cổng OTA ra Internet. Tham khảo [BasicOTA Espressif](https://github.com/espressif/arduino-esp32/blob/3.3.0/libraries/ArduinoOTA/examples/BasicOTA/BasicOTA.ino).

## Cấu hình lượng ăn — bản ghép test và API

| Trường trên web | Ý nghĩa |
|---|---|
| Số phần mỗi lần ăn | 1–20; đơn vị nhân thời gian, không phải số chu kỳ |
| Thời gian chạy / phần | 0,2–10 giây |
| Mốc A / vị trí dừng | 0–360; vị trí trở về khi kết thúc |
| Mốc B | 0–360; cách A ít nhất 5 |
| Nghỉ ở mỗi đầu | 0,2–3 giây; mặc định 0,5 giây như bản test |

**Tổng thời gian = số phần × thời gian/phần**, tối đa 60 giây. Ví dụ 1 phần × 10 giây: servo quét A ↔ B trong 10 giây, tính cả thời gian nghỉ ở mỗi đầu; sau đó trở về A và dừng. 3 phần × 2 giây là một lượt quét liên tục 6 giây, không phải đúng 3 chu kỳ.

Bước cố định **5 đơn vị mỗi 5 ms**, có chặn tại hai đầu kể cả khoảng cách không chia hết cho 5. Khi hết giờ đang ở giữa hành trình hoặc đang nghỉ, kết thúc quét và về A; đoạn về A mất thêm tối đa khoảng 0,36 giây theo tín hiệu điều khiển, chưa gồm đáp ứng cơ khí thực tế. Nhật ký báo hoàn tất sau khi tín hiệu về A đã được gửi. Không có cảm biến đo góc hoặc xác nhận lượng thức ăn.

### Giữ cách ánh xạ của code bạn đã test

Mặc định **A=0, B=360**, công thức giữ nguyên mẫu của bạn: `pulse = 1000 + (index * 1000 + 90) / 180`. Vì vậy 0 → 1000 µs, 180 → 2000 µs, **360 → 3000 µs**. Đây là chỉ số điều khiển, **không chứng minh servo quay thực tế 360°**. 3000 µs nằm ngoài dải thận trọng 1000–2000 µs của bản trước; bản này giữ dải bạn đã xác nhận test thành công. Chỉ dùng dải phù hợp servo/cơ cấu đã thử; giảm mốc B nếu chạm chặn, nóng hoặc rung. Các hằng SERVO_MIN_US/SERVO_MAX_US và INITIAL_STOP_US cũ không còn điều khiển ánh xạ này.

Lưu trên web không làm servo chạy; ESP32 lưu cấu hình NVS và xác nhận, thường 5–10 giây khi rảnh. Đổi cấu hình hủy lệnh còn chờ; lệnh đã giao giữ bản chụp cũ. Khởi động đưa servo về A đã lưu (hoặc 0 nếu chưa có), không tự chạy quét. Khi rảnh giữ PWM tại A.

Máy chủ tự chuyển cấu hình cũ một lần: giữ số phần/thời gian mỗi phần, đổi A=0/B=360/nghỉ 0,5 giây theo bản test, tính lại tổng bằng tích. Giữ tài khoản/lịch/nhật ký, hủy lệnh cũ còn chờ và yêu cầu firmware protocol 4 xác nhận. Firmware dùng khóa NVS sweepcfg riêng để không hiểu nhầm cấu hình mở–giữ–đóng trước đây.

### Luồng mỗi lần gọi API

1. Web gọi POST /api/devices/:id/feed (hoặc lịch đến giờ), tạo một lệnh có thời gian cố định.
2. ESP32 hỏi POST /api/device/poll, nhận bản chụp cấu hình và mã lệnh.
3. Lưu mã lệnh trước khi chạy, quét trong run_ms, về A, gửi ACK completed.
4. Giữ yên tại A, chờ lệnh tiếp theo. Không lặp vô hạn, không phát lại lệnh cũ.

## Lịch và gián đoạn

- Tối đa 30 thiết bị/tài khoản, 12 lịch/thiết bị. Lịch dùng giờ Việt Nam UTC+7 và cấu hình lúc tạo lệnh; bật/tắt/xóa trên web. Đổi giờ/ngày bằng xóa rồi thêm lịch mới.
- Lịch nằm trên máy chủ, không chạy khi máy chủ/mạng ngừng. Không chạy bù phút đã qua; khởi động đúng phút lịch vẫn có thể chạy.
- ESP32 hỏi mỗi 2 giây khi rảnh. Sau 20 giây không liên lạc web báo mất kết nối. Chu kỳ dài tạm ngừng HTTP/OTA để mạng không làm chậm đóng cửa, nên web có thể tạm báo mất kết nối rồi tự trở lại.
- Offline/bận/chưa xác nhận cấu hình: lịch bị bỏ qua. Lệnh chờ quá 15 giây hết hạn. Ít nhất 10 giây giữa lúc tạo hai lệnh; không nhận lệnh mới khi đang xử lý.
- Lệnh chỉ giao một lần tránh cho ăn trùng; mất phản hồi có thể lỡ bữa. Sau 75 giây từ tạo lệnh không có ACK: chưa rõ kết quả.
- Firmware ghi mã lệnh và trạng thái bị ngắt trước khi di chuyển. Sau mất điện, khởi động đóng cửa và báo bị ngắt, không chạy lại chu kỳ. ACK được thử lại riêng.
- “Đã hoàn tất” chỉ xác nhận trình tự tín hiệu đã chạy, chưa xác nhận góc/cửa/thức ăn thật. Chưa có cảm biến vị trí, cân, báo hết hoặc kẹt. Mất điện servo không chủ động giữ/đóng được cửa.
- Đổi sang cơ sở dữ liệu mới khiến ID lệnh bắt đầu lại cần xóa NVS/flash trước khi ghép; cấp lại token cùng cơ sở dữ liệu không cần.

## Truy cập ngoài mạng nhà

Dùng một tiến trình Node, SQLite trên ổ bền vững và HTTPS reverse proxy. Đặt COOKIE_SECURE=1, PUBLIC_ORIGIN=https://feeder.example.com, HOST=127.0.0.1; proxy về cổng 3000. Không chạy nhiều bản sao độc lập.

Firmware dùng SERVER_URL HTTPS, ALLOW_LAN_HTTP=false và ROOT_CA đúng; NTP cần hoạt động để kiểm tra hạn chứng chỉ. Không dùng setInsecure. HTTP chỉ dùng trong mạng riêng tin cậy vì mật khẩu/token không mã hóa khi truyền. Không public trực tiếp cổng 3000; nên có chống lạm dụng đăng ký tại reverse proxy. Chưa triển khai VPS/tên miền thật.

## Kiểm thử

```powershell
node --test test/*.test.mjs
```

Kiểm thử dùng cơ sở dữ liệu riêng: phân quyền, nhiều thiết bị, lịch, ACK, hết hạn, token, giới hạn mốc/thời gian, đồng bộ cấu hình, chặn firmware cũ, hủy lệnh chờ, nâng cấp dữ liệu. Có thêm test/timed-sweep.cpp kiểm tra thuật toán ngay lúc biên dịch: deadline, nghỉ đầu mút, chặn bước, hướng ngược, tràn millis và không tự chạy lại. Firmware đã biên dịch với ESP32 core 3.3.0, ArduinoJson 7.4.3, phân vùng min_spiffs có OTA. **Chưa nạp hoặc đo chuyển động trên board thật trong lần sửa này.**

Có thể tạo thiết bị thử riêng và chạy:

```powershell
$env:DEVICE_TOKEN='token-thiet-bi-thu'
node scripts/simulate-device.mjs
```

Mô phỏng giữ cấu hình RAM, đợi tổng thời gian rồi ACK; không kiểm tra servo/NVS thật. Không dùng chung token với ESP32 thật. Dừng Ctrl+C.

## Cấu trúc và giao thức

- server.mjs: API, SQLite và lịch.
- public/: giao diện web.
- firmware/PetFeeder/: firmware và mẫu cấu hình.
- scripts/simulate-device.mjs: mô phỏng protocol 4.
- test/: kiểm thử tích hợp.

ESP32 gửi Authorization: Bearer DEVICE_TOKEN. POST /api/device/poll gửi protocol:4, applied_config đã lưu; config_error storage/invalid khi thất bại. Cấu hình gồm version, servo_mode (timed_sweep), portions, portion_ms, run_ms, closed_angle, open_angle, move_ms. Phản hồi config/command; command chứa bản chụp thông số cùng id/config_version. Chỉ giao lệnh sau xác nhận đúng cấu hình. Protocol cũ nhận config/command null.

POST /api/device/ack gửi id, status completed/interrupted. Web PATCH thiết bị gửi name và thông số; server tính tổng/phiên bản. Chỉ đổi tên không tăng phiên bản. Web dùng cookie và X-Requested-With: PawMeal.

ZIP nguồn không chứa config.h, cơ sở dữ liệu hoặc build firmware vì có thể chứa thông tin riêng.

Trong protocol 4, portion_ms là thời gian quét mỗi phần; move_ms là thời gian nghỉ ở mỗi đầu (giữ tên trường để không mất tương thích cấu trúc dữ liệu). run_ms = portions * portion_ms, không bao gồm đoạn về A.
