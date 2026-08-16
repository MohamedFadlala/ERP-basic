'use strict';

const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const POWERSHELL_SCRIPT = String.raw`
$machineGuid = [Microsoft.Win32.Registry]::GetValue('HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography', 'MachineGuid', $null)
$systemUuid = Get-CimInstance -ClassName Win32_ComputerSystemProduct -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty UUID
$biosSerial = Get-CimInstance -ClassName Win32_BIOS -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty SerialNumber
[pscustomobject]@{ machineGuid = $machineGuid; systemUuid = $systemUuid; biosSerial = $biosSerial } | ConvertTo-Json -Compress
`;

function normalize(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized || /^(DEFAULT STRING|TO BE FILLED BY O\.E\.M\.|UNKNOWN|NONE|N\/A|0+|-+)$/.test(normalized)) return '';
  return normalized;
}

async function readHardwareValues() {
  if (process.platform !== 'win32') throw new Error('Holool ERP licensing requires Windows.');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_SCRIPT
  ], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  const values = JSON.parse(String(stdout || '').trim());
  return {
    machineGuid: normalize(values.machineGuid),
    systemUuid: normalize(values.systemUuid),
    biosSerial: normalize(values.biosSerial)
  };
}

async function getHardwareId() {
  const values = await readHardwareValues();
  if (Object.values(values).filter(Boolean).length < 2) {
    throw new Error('At least two stable hardware identifiers are required to activate this computer.');
  }
  const input = `HOLOOL-ERP|${values.machineGuid}|${values.systemUuid}|${values.biosSerial}`;
  const hex = crypto.createHash('sha256').update(input, 'utf8').digest('hex').toUpperCase().slice(0, 32);
  return hex.match(/.{8}/g).join('-');
}

module.exports = { getHardwareId };
