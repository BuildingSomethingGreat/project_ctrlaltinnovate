function generateEmailTemplate({ appName, title, message, details }) {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body {
            font-family: Arial, sans-serif;
            background-color: #f7fafc;
            color: #2d3748;
            margin: 0;
            padding: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
          }
          .container {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
            max-width: 600px;
            text-align: center;
          }
          .title {
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 16px;
          }
          .message {
            font-size: 16px;
            margin-bottom: 16px;
          }
          .details {
            font-size: 14px;
            color: #4a5568;
            margin-top: 16px;
          }
          .footer {
            margin-top: 24px;
            font-size: 12px;
            color: #a0aec0;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="title">${title}</div>
          <div class="message">${message}</div>
          <div class="details">${details}</div>
          <div class="footer">Sent by ${appName}</div>
        </div>
      </body>
    </html>
  `;
}

module.exports = { generateEmailTemplate };