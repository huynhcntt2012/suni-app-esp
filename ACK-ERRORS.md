# Cập nhật lỗi ACK trên web (firmware protocol 4)

Gói này dành cho firmware protocol 4 bạn đang dùng. Giữ config.h hiện tại; không dùng gói để thay firmware protocol 5 đang cấu hình qua điện thoại.

1. Cập nhật server.mjs và public trên server. Giữ nguyên data và cấu hình Docker.
2. Chạy docker compose up -d --build --force-recreate suni-app-esp.
3. Nạp firmware/PetFeeder/PetFeeder.ino, giữ config.h của bạn và TimedSweep.h cùng thư mục. Các header bổ sung nếu có không cần thay.
4. Tải lại web bằng Ctrl+Shift+R. Lệnh mới sẽ có lý do dưới trạng thái trong nhật ký.

ackStatus giữ completed/interrupted; error_code gửi lý do lỗi PWM, NVS, brownout, watchdog, panic hoặc khởi động lại. Bản ghi lịch sử cũ không thể suy ra nguyên nhân. Khi mất nguồn/mạng, lỗi chỉ gửi được khi board hoạt động và kết nối lại. Không xác nhận chuyển động cơ khí hay thức ăn đã rơi.

Nếu lỗi NVS làm không lưu được lý do, lý do chi tiết trong RAM có thể mất sau reset. Không xóa ID, Wi-Fi, token hay database trong lần cập nhật này.

## Bản sửa lưu trạng thái lệnh ngày 07/10/2026

Firmware lưu last/pending/status/error chung trong khóa NVS exec4. Lần nâng cấp đầu đọc và giữ ID từ các khóa cũ, không reset ID. Sau đó exec4 là nguồn dữ liệu chính; không dùng đoạn reset chỉ xóa last/pending của bản cũ. Không hạ firmware về bản dùng khóa cũ vì bộ đếm cũ sẽ không theo kịp. Chỉ cập nhật RAM sau khi lưu bản ghi thành công. ACK tiếp tục được gửi khi chức năng chuyển động bị khóa do lỗi PWM/NVS.

Không tìm thấy lỗi giữ biến chuyển động từ lệnh trước: kiểm thử 100 lệnh liên tiếp 1,5 giây đều về A. Kết quả thử phần mềm không xác nhận nguồn, servo hoặc NVS khi mất điện thực tế. Các dòng interrupted cũ không đủ dữ liệu để xác định nguyên nhân. Mỗi board phải dùng token riêng; hai board cùng token có thể nhận lệnh/ACK dưới cùng thiết bị trên web.
