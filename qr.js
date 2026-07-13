const QRCode = require('qrcode');

async function generateQrPngBuffer(url) {
  return QRCode.toBuffer(url, { width: 300, margin: 1, color: { dark: '#1B1D21', light: '#F2EFE9' } });
}

module.exports = { generateQrPngBuffer };
