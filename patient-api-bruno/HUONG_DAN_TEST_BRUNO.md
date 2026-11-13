# HƯỚNG DẪN KIỂM THỬ API BACKEND BỆNH NHÂN BẰNG BRUNO (DRMAYDAY)

Tài liệu này hướng dẫn cách import và sử dụng file collection **`DrMayDay_Patient_Backend_Bruno.json`** trong ứng dụng **Bruno** để kiểm thử toàn bộ các API `GET`, `POST`, `PUT`, `PATCH`, `DELETE` của phân hệ Bệnh nhân trên hệ thống **Dual-DB mới** của `drmayday-system`.

---

## 1. Kiến trúc Dual-DB & Chuẩn bị Môi trường

Hệ thống backend mới (`drmayday-system/backend`) vận hành song song **2 CSDL + 1 Storage**:
1. **Main DB (PostgreSQL `160.191.46.107:6432/mayday` — `DATABASE_URL`)**: Lưu dữ liệu lõi bệnh viện (`vaitro`, `nguoi`, `taikhoan`, `benhnhan`, `sanglocbaodongdo`, `hosobenhan`/`benhanmaydaycap`/`benhanmaydayman`, `phienkham`/`phienkhamcap`/`phienkhamman`, `ketquacanlamsang`, `donthuoc`/`chitietdonthuoc`, `chukytheodoiuas7`, `nhatkyuashangngay`, `nhatkyaashangngay`, `dottonthuongda`, `vitritonthuong`, `tepdinhkem`, `anhchuptonthuong`).
2. **Sub DB (Supabase PostgreSQL via Prisma — `SUB_DATABASE_URL`)**: Lưu dữ liệu mở rộng & dynamic schema (`templates`, `template_sections`, `template_questions`, `patient_extra_profiles`, `password_reset_tokens`, `token_blacklist`, `medical_record_meta`, `medical_record_answers`, `answer_images`, `uas7_notes`, `lesion_episode_meta`, `lesion_location_meta`, `anh_ton_thuong_mo_rong`).
3. **Supabase Storage (bucket `mayday-attachments`)**: Lưu tệp ảnh upload thực tế qua `multer` (`POST /api/v1/image-attachments/upload`).

### Các bước chạy Backend Local
1. **Kiểm tra file cấu hình `.env`** tại `D:\CNWeb\BTL\drmayday-system\.env` (khớp với `team_shared_bundle/.env`, mặc định `PORT=5000`).
2. **Cài đặt thư viện & sinh Prisma Client:**
   ```powershell
   cd D:\CNWeb\BTL\drmayday-system\backend
   npm install
   npx prisma generate
   ```
3. **Kiểm tra kết nối Dual-DB:**
   ```powershell
   node test_connections.js
   ```
   Đảm bảo hiển thị thành công cả **Main DB (`mayday`)** và **Sub DB Supabase**.
4. **Khởi chạy server Backend:**
   ```powershell
   npm run dev
   ```
   Server mặc định chạy tại `http://localhost:5000` (prefix API: `http://localhost:5000/api/v1`).

---

## 2. Cách Mở Collection Trong Bruno

### Cách 1 (Khuyên dùng — Giống cấu trúc `drmayday-system/bruno`): Mở trực tiếp Collection `.bru`
1. Mở ứng dụng **Bruno**.
2. Bấm **`Open Collection`** ➔ chọn thẳng thư mục:
   ```text
   D:\CNWeb\BTL\patient-api-bruno\bruno
   ```
3. Ở góc trên bên phải của Bruno, bấm chọn Environment **`Local`** (nạp từ `environments/Local.bru`, gồm sẵn `baseUrl`, `rootUrl`, `patientId`, `recordId`, `sessionId`, `answerId`, `episodeId`, `locationId`, `attachmentId`, `photoId`, `answerImageId`, `templateId`).

Thư mục `bruno/` gồm **19 thư mục riêng cho từng nhóm API (75 request `.bru`)**:
* `00-Health` (1) & `01-Auth` (8): `/health`, `signup`, `login` (Patient/Doctor/Admin), `/auth/me`, `forgot-password`, `change-password`, `logout`.
* `02-Profile` (2) & `03-Red-Flag-Screening` (2): `GET/PUT /profile`, `POST/GET /red-flag-screening`.
* `04-Patients` (9) & `05-Doctor-Patients` (2): `/patients`, `/patients/benh-nhan`, `/patients/search`, `/patients/:id`, `/patients/benh-nhan/:id/ho-so`, `/patients/ho-so`, `/patients/ho-so/:id/phien-kham`, `/patients/medical-records/:id/close`, `/doctor/patients`.
* `06-Templates` (2) & `07-Medical-Records` (15): `/templates`, `/templates/:id`, `/medical_records/classify-questions`, `/medical_records/classify`, CRUD `/medical_records`, `/patients/:patientId/history`, `/answers`, `/summary`, `/history`, `/close`, `/accept`, `/complete`, `DELETE`.
* `08-Lab-Results` (2), `09-Prescriptions` (2), `10-UAS7-Scores` (3), `11-AAS-Scores` (2), `12-Clinical-Legacy` (4): `/lab-results`, `/prescriptions`, `/uas7-scores/*`, `/aas-scores`, `/clinical/uas7/*`, `/clinical/don-thuoc/:sessionId`, `/clinical/thuoc`.
* `13-Lesion-Episodes` (5), `14-Lesion-Locations` (4), `15-Image-Attachments` (3), `16-Lesion-Photos` (4), `17-Answer-Images` (3), `18-Lesions-Legacy` (2): Tổn thương da 3 cấp, upload/xóa ảnh lên Supabase Storage (`/image-attachments/upload`), ảnh 3 mốc (`lesion-photos`), ảnh câu trả lời (`answer-images`), `/lesions/vi-tri`, `/lesions/anh-mo-rong`.

### Cách 2: Import 1 file duy nhất (`DrMayDay_Patient_Backend_Bruno.json`)
1. Mở **Bruno** ➔ **`Import Collection`** ➔ **`Postman Collection`**.
2. Chọn file `D:\CNWeb\BTL\patient-api-bruno\DrMayDay_Patient_Backend_Bruno.json` và lưu collection.

### Các Biến (Environment / Collection Variables)
Mở Environment **`Local`** (nếu dùng Cách 1) hoặc tab **Vars** (nếu dùng Cách 2) để xem/sửa:

| Tên biến | Giá trị mặc định | Mô tả |
| :--- | :--- | :--- |
| `baseUrl` | `http://localhost:5000/api/v1` | URL gốc API Local |
| `rootUrl` | `http://localhost:5000` | URL gốc cho `/health` |
| `testPatientUser` / `patientUser` | `0912345678` | SĐT Bệnh nhân test (tự cập nhật khi chạy `02`/`00.2 Đăng ký`) |
| `testPatientPassword` / `patientPassword` | `Patient@123` | Mật khẩu Bệnh nhân test (tự điền qua pre-request nếu để trống ở Cách 1) |
| `doctorUser` | `0901000002` | SĐT Bác sĩ test |
| `doctorPassword` | *(điền mật khẩu hoặc pre-request tự điền `Doctor@123`)* | Mật khẩu Bác sĩ test |
| `adminUser` | `0900000001` | SĐT Admin test |
| `adminPassword` | *(điền mật khẩu hoặc pre-request tự điền `Admin@123`)* | Mật khẩu Admin test |
| `patientToken`, `doctorToken`, `adminToken` | *(tự động điền)* | Tự lưu sau khi chạy Login |
| `patientId`, `recordId`, `sessionId`, `answerId`, `episodeId`, `locationId`, `attachmentId`, `photoId`, `answerImageId` | *(tự cập nhật từ script)* | Tự động gán khi chạy lần lượt các bước test |
| `templateId` | `TMPL_URTICARIA_CHRONIC_INIT` | Mã (hoặc ID số `1`, `2`, `3`) của biểu mẫu động |

---

## 3. Quy trình Chạy Test Theo Thứ Tự

### Bước 1: Kiểm tra Server & Xác thực (`00. Health & Auth`)
1. Chạy **`00.1 Health Check (GET /health)`** ➔ Kỳ vọng `200 OK`, `status: "ok"`.
2. Nếu muốn test bằng tài khoản mới, chạy **`00.2 Đăng ký Bệnh nhân mới (POST /auth/signup)`** (tự sinh SĐT ngẫu nhiên, lưu cả Main DB `nguoi`/`taikhoan`/`benhnhan` và Sub DB `patient_extra_profiles`).
3. Chạy **`00.3 Đăng nhập Bệnh nhân`** ➔ tự lưu `patientToken` và `patientId`.
4. Chạy **`00.4 Đăng nhập Bác sĩ`** và **`00.5 Đăng nhập Admin`** (nếu cần test các API phân quyền nhân viên y tế / kê đơn / cận lâm sàng).
5. Chạy **`00.6 GET /auth/me`**, **`00.7 POST /auth/forgot-password`** (sinh OTP trên Sub DB `password_reset_tokens`), **`00.8 POST /auth/change-password`**.
6. *Chỉ chạy `00.9 Đăng xuất` ở cuối buổi test* vì token sẽ bị đưa vào `token_blacklist` trên Sub DB.

### Bước 2: Test Module Patient Core (`01. Patient Module (drmayday-system - Đã fix Dual-DB & RBAC)`)
* Dùng `doctorToken` hoặc `adminToken` cho `01.1` / `01.2` (`GET /patients`, `GET /patients/benh-nhan`).
* Dùng `patientToken` (hoặc `doctorToken`) cho `01.3` (xem hồ sơ BN — bệnh nhân chỉ xem được hồ sơ của chính mình, truy cập BN khác trả `403` mã `3106`), `01.4` (`POST /patients/ho-so`), `01.5` (`GET /patients/ho-so/:ma_ho_so/phien-kham`).

### Bước 3: Profile cá nhân & Sàng lọc báo động đỏ (`02. Profile & Sàng lọc Báo động đỏ`)
* Chạy **`02.1 GET /profile`** và **`02.2 PUT /profile`** (tự chuẩn hóa giới tính, nghề nghiệp, SĐT người nhà và đồng bộ trường mở rộng vào Sub DB).
* Chạy **`02.3 POST /red-flag-screening`** (lưu lượt sàng lọc vào `public.sanglocbaodongdo`).

### Bước 4: Quản lý Bệnh nhân, Phân loại & Hồ sơ Bệnh án (`03. Bệnh nhân & Hồ sơ Bệnh án`)
* **`03.1` ➔ `03.3`**: Tìm kiếm (`GET /patients/search`), xem chi tiết (`GET /patients/:id`), cập nhật hành chính (`PUT /patients/:id`).
* **`03.4` ➔ `03.5`**: Lấy câu hỏi phân loại (`GET /medical_records/classify-questions`) và phân loại Cấp/Mạn (`POST /medical_records/classify`).
* **`03.6` ➔ `03.9`**: Tạo hồ sơ bệnh án (`POST /medical_records` — tự ghi đồng thời `hosobenhan` + subtype `benhanmaydaycap`/`benhanmaydayman` và `medical_record_meta`), xem lịch sử bệnh án của BN, xem chi tiết & tóm tắt.
* **`03.10` & `03.11`**: Lưu/cập nhật câu trả lời động trên Sub DB (`PUT /medical_records/{{recordId}}/answers`) và lấy lại để tự lưu `answerId`.
* **`03.12`**: Đóng hồ sơ (`PUT /patients/medical-records/{{recordId}}/close` hoặc `POST /medical_records/{{recordId}}/close`). Sau khi đóng (`pending`), bệnh nhân sửa sẽ bị chặn với mã `4003`.
* **`03.13`**: Xem biểu mẫu 4 tầng từ Sub DB (`GET /templates/{{templateId}}`).

### Bước 5: Thang điểm UAS7, Cận lâm sàng & Đơn thuốc (`04`)
* **`04.1` ➔ `04.3`**: Kiểm tra điều kiện UAS7 (`GET /uas7-scores/eligibility`), chấm điểm hàng ngày (`POST /uas7-scores` — ghi vào `chukytheodoiuas7`/`nhatkyuashangngay` trên Main DB + `uas7_notes` trên Sub DB; chặn chấm trùng ngày `409` mã `4009`), xem lịch sử theo dõi (`GET /uas7-scores/patient/{{patientId}}`).
* **`04.4` & `04.5`**: Xem chu kỳ UAS7 và ghi nhật ký trực tiếp qua `/clinical/uas7/*`.
* **`04.6` ➔ `04.8`**: Xem kết quả cận lâm sàng (`GET /lab-results/{{recordId}}`), xem đơn thuốc theo bệnh án (`GET /prescriptions/{{recordId}}`) hoặc theo phiên khám (`GET /clinical/don-thuoc/{{sessionId}}`). *(Lưu ý: tạo mới cận lâm sàng / đơn thuốc dùng tài khoản Bác sĩ/Admin qua `POST /lab-results`, `POST /prescriptions`).*

### Bước 6: Tổn thương da 3 cấp & Kho ảnh Supabase Storage (`05`)
* **`05.1` ➔ `05.5`**: Tạo / xem / cập nhật / xóa đợt tổn thương (`lesion-episodes` — tự map `hosobenhan` Cấp/Mạn thông qua `lesion_episode_meta`). *(Nếu chưa muốn xóa đợt vừa tạo để test tiếp `05.6`, hãy bỏ qua `05.5` rồi chạy sau cùng).*
* **`05.6` ➔ `05.9`**: Thêm / xem / sửa / xóa vị trí tổn thương (`lesion-locations`).
* **`05.10` Upload ảnh (`POST /image-attachments/upload`)**: Mở tab **Body** (`multipart/form-data`), ở dòng key `file` chọn 1 ảnh `.jpg`/`.png`/`.webp` (< 10MB) trên máy rồi bấm **Send** ➔ ảnh được đẩy lên bucket **`mayday-attachments`** trên Supabase Storage, đồng thời ghi `tepdinhkem` (Main DB) & `anh_ton_thuong_mo_rong` (Sub DB), và tự lưu `attachmentId`.
* **`05.11` & `05.12`**: Liệt kê ảnh theo user và xóa ảnh (xóa cả trên Supabase Storage + Main/Sub DB — chạy `05.12` ở cuối nếu còn dùng `attachmentId` cho `05.13`/`05.17`).
* **`05.13` ➔ `05.16`**: Tạo ảnh tổn thương 3 mốc tiến triển (`lesion-photos`), lọc theo vị trí, cập nhật mốc (`PATCH /lesion-photos/{{photoId}}/milestone`), xóa ảnh tổn thương.
* **`05.17` ➔ `05.19`**: Gắn ảnh vào câu trả lời phiếu khám (`answer-images`), xem và gỡ liên kết.
* **`05.20` & `05.21`**: Các route `/lesions/vi-tri` và `/lesions/anh-mo-rong` tương thích ngược với module lesion ban đầu.

---

## 4. Mã lỗi Nghiệp vụ Chuẩn
* `1000`: Thành công (`success: true`)
* `2001` / `2003`: Thiếu tham số hoặc dữ liệu không hợp lệ (`400`)
* `3001` / `3007`: Chưa đăng nhập / token hết hạn / đã logout (`401`) hoặc không tìm thấy tài nguyên (`404`)
* `3106`: Không có quyền truy cập tài nguyên của người khác (`403` — ví dụ bệnh nhân xem bệnh án bệnh nhân khác)
* `4003`: Hồ sơ đã đóng/khóa (`pending`/`in_progress`/`completed`), bệnh nhân không thể sửa (`400`)
* `4009`: Dữ liệu trùng lặp (ví dụ chấm UAS7 2 lần trong cùng 1 ngày khi chưa bật `overwrite: true`, `409`)
