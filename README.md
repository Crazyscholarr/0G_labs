
# 🚀 0G-Galileo-Testnet Faucet & Token Automation

**Ngôn ngữ | Language**: 🇻🇳 Tiếng Việt | 🇺🇸 English

---

## 📌 Giới thiệu | Introduction

🇻🇳 **0G Labs Automation Tool** là công cụ giúp tự động hóa các thao tác với mạng **0G Galileo Testnet**:
- Nhận token từ faucet.
- Mint token từ contract.
- Thực hiện swap token.
- Giải Captcha tự động bằng 2Captcha.
- Hỗ trợ proxy và nhiều ví đồng thời.

🇺🇸 **0G Labs Automation Tool** is a script that automates interaction with the **0G Galileo Testnet**:
- Claim tokens from the faucet.
- Mint tokens via contracts.
- Swap tokens randomly.
- Solve hCaptcha using 2Captcha.
- Supports proxies and batch wallet processing.

---

## ⚙️ Cấu hình | Configuration

Tất cả cấu hình được đặt trong file `config.json`.

All configuration options are defined in the `config.json` file.

```json
{
  "captcha": {
    "apiKey": "YOUR_2CAPTCHA_API_KEY"
  },
  "settings": {
    "pauseBetweenAttempts": [5, 10],
    "pauseBetweenSwaps": [10, 20],
    "maxRetries": 3,
    "waitForTransactionConfirmationInSeconds": 120,
    "numberOfSwaps": [1, 3],
    "balancePercentToSwap": [50, 90]
  }
}
```

### 📝 Các file cần chuẩn bị | Required files

| File                | Nội dung                                             | Description                                   |
|---------------------|------------------------------------------------------|-----------------------------------------------|
| `config.json`       | Cấu hình bot                                         | Bot configuration                             |
| `private_keys.txt`  | Danh sách các private key ví                         | List of wallet private keys                   |
| `proxies.txt`       | (Tùy chọn) Danh sách proxy `ip:port` hoặc `user:pass@ip:port` | Optional proxy list                           |
| `twitter_tokens.txt`| Token xác thực Twitter OAuth                         | Twitter OAuth tokens for faucet connection    |

---

## ▶️ Hướng dẫn sử dụng | How to use

### 1. Cài đặt | Install dependencies

```bash
npm install
```

### 2. Chạy chương trình | Run the bot

```bash
npm start
```

### 3. Chọn chức năng | Choose operation

Chạy xong, chương trình sẽ hiện menu:

```text
1. Faucet
2. Mint Token
3. Swap
4. Exit
```

- Chọn `1`: Nhận OG token từ faucet.
- Chọn `2`: Mint các token như USDT, BTC, ETH.
- Chọn `3`: Swap token ngẫu nhiên.
- Chọn `4`: Thoát.

After starting, the script will prompt a menu. Choose a number (1-4) to execute the task.

---

## 📦 Các thư viện sử dụng | Dependencies

| Thư viện (Lib)           | Chức năng (Purpose)                                  |
|--------------------------|------------------------------------------------------|
| `web3`                   | Tương tác với mạng EVM blockchain                    |
| `axios`                  | Gửi HTTP request                                     |
| `2captcha`               | Tích hợp giải Captcha tự động                        |
| `winston`                | Ghi log rõ ràng                                      |
| `colors`                 | Màu sắc hiển thị trong terminal                      |
| `rotating-file-stream`   | Tạo file log có xoay vòng (rotation & compression)   |

---

## 📁 Cấu trúc thư mục | Project structure

```bash
├── index.js                # File chính chạy bot
├── config.json             # File cấu hình chính
├── private_keys.txt        # Danh sách private key
├── proxies.txt             # Danh sách proxy (nếu có)
├── twitter_tokens.txt      # Danh sách Twitter token
├── logs/
│   └── app.log             # File ghi log hoạt động
├── package.json            # Thông tin gói & dependency
```

---

## ❗Lưu ý | Notes

- Các private key cần ở định dạng hex, ví dụ: `0xabc123...`
- Token Twitter phải còn hiệu lực và có quyền truy cập faucet.
- Nên sử dụng proxy riêng cho mỗi ví nếu chạy nhiều account.

---

## 📞 Hỗ trợ | Support

Nếu bạn gặp lỗi, vui lòng:
- Kiểm tra `logs/app.log`
- Tạo issue mới tại repository
- Hoặc liên hệ Telegram
If you run into any problems:
- Check the `logs/app.log`
- Open an issue in the repo
- Or contact via Telegram

---

## 📜 Giấy phép | License

MIT License © 0G Labs.
