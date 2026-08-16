'use strict';

const LEFT_ODD = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const LEFT_EVEN = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const RIGHT = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

function ean13CheckDigit(firstTwelveDigits) {
  const value = String(firstTwelveDigits || '');
  if (!/^\d{12}$/.test(value)) throw new Error('EAN-13 requires exactly 12 digits before the check digit.');
  const sum = [...value].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return String((10 - (sum % 10)) % 10);
}

function generateInternalEan13(productId, prefix = '20') {
  const id = String(productId || '');
  if (!/^\d{1,10}$/.test(id) || !/^2\d$/.test(prefix)) throw new Error('Unable to generate an internal product barcode.');
  const firstTwelve = `${prefix}${id.padStart(10, '0')}`;
  return `${firstTwelve}${ean13CheckDigit(firstTwelve)}`;
}

function isValidEan13(value) {
  const barcode = String(value || '');
  return /^\d{13}$/.test(barcode) && barcode.endsWith(ean13CheckDigit(barcode.slice(0, 12)));
}

function renderEan13Svg(value) {
  const barcode = String(value || '');
  if (!isValidEan13(barcode)) throw new Error('The product barcode is not a valid EAN-13 value.');
  const parity = PARITY[Number(barcode[0])];
  let bits = '101';
  for (let index = 1; index <= 6; index += 1) {
    const digit = Number(barcode[index]);
    bits += parity[index - 1] === 'L' ? LEFT_ODD[digit] : LEFT_EVEN[digit];
  }
  bits += '01010';
  for (let index = 7; index <= 12; index += 1) bits += RIGHT[Number(barcode[index])];
  bits += '101';
  const quietZone = 9;
  const bars = [...bits].map((bit, index) => bit === '1'
    ? `<rect x="${quietZone + index}" y="0" width="1" height="${index < 3 || (index >= 45 && index < 50) || index >= 92 ? 46 : 40}"/>`
    : '').join('');
  return `<svg class="ean13" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 113 46" role="img" aria-label="Barcode ${barcode}" shape-rendering="crispEdges"><rect width="113" height="46" fill="#fff"/><g fill="#000">${bars}</g></svg>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function buildBarcodeLabelsHtml(product, copies = 1, branding = {}) {
  const count = Math.max(1, Math.min(100, Math.trunc(Number(copies) || 1)));
  const barcode = String(product?.barcode || '');
  const svg = renderEan13Svg(barcode);
  const businessName = String(branding.businessName || 'Holool ERP Enterprise');
  const logo = branding.logoDataUrl ? `<img src="${branding.logoDataUrl}" alt="">` : '';
  const label = `<section class="label"><div class="brand">${logo}<span>${escapeHtml(businessName)}</span></div><div class="name">${escapeHtml(product?.name || 'Product')}</div><div class="sku">${escapeHtml(product?.sku ? `SKU: ${product.sku}` : 'Inventory item')}</div>${svg}<div class="digits">${escapeHtml(barcode)}</div><div class="powered">Powered by Holool Tech - Holool.tech</div></section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Barcode labels</title><style>
    @page { size: 50mm 30mm; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; font-family: Arial, sans-serif; color: #000; }
    .label { width: 50mm; height: 30mm; padding: 1mm 3mm .7mm; display: flex; flex-direction: column; align-items: center; overflow: hidden; page-break-after: always; break-after: page; }
    .label:last-child { page-break-after: auto; break-after: auto; }
    .brand { width: 100%; height: 3mm; display: flex; align-items: center; justify-content: center; gap: 1mm; overflow: hidden; font-size: 5pt; font-weight: 700; white-space: nowrap; }
    .brand img { width: 3mm; height: 3mm; object-fit: contain; }
    .name { width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; font-size: 9pt; font-weight: 700; line-height: 1.15; }
    .sku { width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; font-size: 6.5pt; line-height: 1.2; }
    .ean13 { width: 44mm; height: 14mm; margin-top: .3mm; }
    .digits { margin-top: -.3mm; font: 7pt 'Courier New', monospace; letter-spacing: 1.1pt; }
    .powered { width: 100%; margin-top: auto; text-align: center; color: #444; font-size: 4pt; white-space: nowrap; }
  </style></head><body>${label.repeat(count)}</body></html>`;
}

module.exports = { ean13CheckDigit, generateInternalEan13, isValidEan13, renderEan13Svg, buildBarcodeLabelsHtml };
