# Test MG996R 180° + ArduinoOTA

Mở `test.ino` trong thư mục `test`. Dùng ESP32 Dev Module, Espressif core 3.x; không cần ArduinoJson hoặc ESP32Servo. Sketch độc lập, không kết nối web PawMeal.

Nếu chưa có `config.h`, chép `config.example.h` thành `config.h` rồi điền Wi-Fi 2,4 GHz và mật khẩu OTA riêng ít nhất 8 ký tự. Trong workspace này, config.h đã được tạo từ thông tin kết nối của firmware hiện có; không công khai tệp đó.

Chọn phân vùng có OTA đúng với bản đang chạy (ví dụ Minimal SPIFFS cho board 4 MB). Nếu board đã chạy firmware có OTA, chọn cổng mạng hiện tại và Upload bằng mật khẩu OTA của bản đang chạy. Nếu chưa có OTA hoặc cần đổi bảng phân vùng, nạp USB trước. Sau khi nạp bản test, tên cổng chuyển thành `pawmeal-test-<MAC>`; Serial 115200 baud hiển thị địa chỉ IP. Các lần nạp tiếp theo chọn cổng mới này.

Servo bắt đầu ở góc lệnh 60°, sau 3 giây lặp **60° → 120° → 60°**, mỗi bước 1°/20 ms, giữ mỗi đầu 1 giây. Tiếp tục chạy cả khi không có Wi-Fi. Chỉnh ANGLE_A, ANGLE_B, STEP_MS, HOLD_MS ở đầu test.ino. Đây là chuyển động qua lại của servo vị trí, không quay liên tục cùng một chiều. Xung mặc định 1000–2000 µs; góc thực tế cần hiệu chỉnh.

Thử khi tháo cơ cấu/tay đòn để tránh ép chặn. GPIO18 nối tín hiệu servo; nguồn ngoài phù hợp cấp servo, âm nguồn nối GND ESP32; không cấp servo từ 3V3. ESP32 có thể cấp USB.

Serial gửi `p` để tạm dừng và giữ góc, `r` để chạy lại. OTA được phục vụ trong lúc test nhờ dùng millis; khi bắt đầu cập nhật, chương trình dừng đổi góc và giữ vị trí hiện tại. Nếu OTA lỗi, giữ trạng thái tạm dừng để bạn nạp lại. Sau khởi động lại bản test sẽ tự chạy.

Test xong, nạp lại PetFeeder.ino qua cổng mạng của bản test để khôi phục điều khiển web/lịch. Sketch này không xóa NVS của PawMeal. Không có lệnh cho ăn từ web trong lúc chạy bản test.
