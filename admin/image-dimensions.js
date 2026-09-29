/*
  Lector de dimensiones de imagen (ancho x alto) sin dependencias --
  =====================================================================
  Usado por pipeline.js (validateImagePublication, control de "dimensiones
  insuficientes" de la auditoría de imágenes, sept. 2026) para leer el
  tamaño real de una imagen sin necesitar Python/PIL en el camino
  síncrono de guardar un artículo (POST /api/articles corre en el hilo
  principal del servidor -- no puede esperar un subproceso por cada
  imagen en cada guardado). Solo lee encabezados (no decodifica la
  imagen entera): soporta JPEG, PNG, GIF y WEBP (los 4 formatos que
  admin/server.js acepta para subir, ver IMAGE_EXT).

  Devuelve { width, height } o null si no pudo leerlas (formato no
  reconocido, archivo corrupto, etc.) -- en ese caso, quien llama decide
  qué hacer (validateImagePublication lo trata como "no se pudo
  verificar", no como "tamaño insuficiente", para no bloquear con un
  falso positivo).
*/

function readPng(buf) {
  // Firma PNG de 8 bytes, seguida del chunk IHDR (siempre el primero):
  // 4 bytes de longitud, "IHDR", 4 bytes de ancho, 4 bytes de alto.
  if (buf.length < 24) return null;
  if (buf.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
  var width = buf.readUInt32BE(16);
  var height = buf.readUInt32BE(20);
  return { width: width, height: height };
}

function readGif(buf) {
  if (buf.length < 10) return null;
  var header = buf.toString('ascii', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') return null;
  var width = buf.readUInt16LE(6);
  var height = buf.readUInt16LE(8);
  return { width: width, height: height };
}

function readJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  var offset = 2;
  while (offset < buf.length - 9) {
    if (buf[offset] !== 0xFF) { offset++; continue; }
    var marker = buf[offset + 1];
    // Marcadores SOFn (Start Of Frame) que llevan ancho/alto -- se
    // excluyen los de relleno (0x01, 0xD0-0xD9) y los que no son SOF.
    var isSOF = (marker >= 0xC0 && marker <= 0xCF) && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    var segLen = buf.readUInt16BE(offset + 2);
    if (isSOF) {
      var height = buf.readUInt16BE(offset + 5);
      var width = buf.readUInt16BE(offset + 7);
      return { width: width, height: height };
    }
    if (marker === 0xD8 || marker === 0xD9) { offset += 2; continue; }
    offset += 2 + segLen;
  }
  return null;
}

function readWebp(buf) {
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  var chunkType = buf.toString('ascii', 12, 16);
  if (chunkType === 'VP8 ') {
    // Lossy: ancho/alto de 14 bits cada uno, en el byte 26.
    var width = buf.readUInt16LE(26) & 0x3FFF;
    var height = buf.readUInt16LE(28) & 0x3FFF;
    return { width: width, height: height };
  }
  if (chunkType === 'VP8L') {
    var b = buf.readUInt32LE(21);
    var w = (b & 0x3FFF) + 1;
    var h = ((b >> 14) & 0x3FFF) + 1;
    return { width: w, height: h };
  }
  if (chunkType === 'VP8X') {
    var w2 = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
    var h2 = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
    return { width: w2, height: h2 };
  }
  return null;
}

function readImageDimensions(buffer) {
  try {
    return readPng(buffer) || readJpeg(buffer) || readGif(buffer) || readWebp(buffer) || null;
  } catch (e) {
    return null;
  }
}

module.exports = { readImageDimensions: readImageDimensions };
