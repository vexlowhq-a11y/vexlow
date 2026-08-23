// Generador de grillas de sopa de letras — módulo universal:
// funciona como <script src="generador-grilla.js"></script> en el navegador
// (expone `window.GeneradorGrilla`) y como `require('./generador-grilla.js')` en Node.
//
// Idea central: el nivel guardado en la base de datos NUNCA tiene una grilla fija —
// solo tiene la lista de palabras. Cada vez que se juega (o reintenta) un nivel se
// llama a generarGrilla() de nuevo, con una disposición al azar distinta. Así, si no
// completás el nivel, la próxima vez las palabras están en otro lugar.

(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.GeneradorGrilla = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const DIRECCIONES = [
    [0, 1],   // horizontal
    [0, -1],  // horizontal_inversa
    [1, 0],   // vertical
    [-1, 0],  // vertical_inversa
    [1, 1],   // diagonal_abajo_derecha
    [1, -1],  // diagonal_abajo_izquierda
    [-1, 1],  // diagonal_arriba_derecha
    [-1, -1], // diagonal_arriba_izquierda
  ];
  const NOMBRE_DIRECCION = [
    'horizontal', 'horizontal_inversa', 'vertical', 'vertical_inversa',
    'diagonal_abajo_derecha', 'diagonal_abajo_izquierda',
    'diagonal_arriba_derecha', 'diagonal_arriba_izquierda',
  ];
  const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  function limpiarPalabra(p) {
    return p
      .toUpperCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita tildes
      .replace(/Ñ/g, 'N')
      .replace(/[^A-Z]/g, ''); // solo A-Z: sin espacios, números ni símbolos
  }

  function tamanoInicial(palabras) {
    const masLarga = Math.max(...palabras.map((p) => p.length));
    const totalLetras = palabras.reduce((s, p) => s + p.length, 0);
    return Math.max(masLarga + 2, Math.ceil(Math.sqrt(totalLetras * 2.2)));
  }

  function intentarColocar(grilla, tamano, palabra, azar) {
    for (let intento = 0; intento < 200; intento++) {
      const dirIndice = Math.floor(azar() * DIRECCIONES.length);
      const [df, dc] = DIRECCIONES[dirIndice];
      const f0 = Math.floor(azar() * tamano);
      const c0 = Math.floor(azar() * tamano);
      const fFin = f0 + df * (palabra.length - 1);
      const cFin = c0 + dc * (palabra.length - 1);
      if (fFin < 0 || fFin >= tamano || cFin < 0 || cFin >= tamano) continue;

      let cabe = true;
      for (let i = 0; i < palabra.length; i++) {
        const f = f0 + df * i, c = c0 + dc * i;
        const actual = grilla[f][c];
        if (actual && actual !== palabra[i]) { cabe = false; break; }
      }
      if (!cabe) continue;

      for (let i = 0; i < palabra.length; i++) {
        grilla[f0 + df * i][c0 + dc * i] = palabra[i];
      }
      return { fila_inicio: f0, columna_inicio: c0, direccion: NOMBRE_DIRECCION[dirIndice] };
    }
    return null;
  }

  /**
   * Genera una grilla nueva para una lista de palabras. Al azar cada vez que se llama
   * (usa Math.random salvo que se pase `azar` para tests determinísticos).
   * @param {string[]} palabrasCrudas
   * @param {{ azar?: () => number, maxAgrandados?: number }} [opciones]
   * @returns {{ filas: number, columnas: number, letras: string[], palabras_clave: Array }}
   */
  function generarGrilla(palabrasCrudas, opciones = {}) {
    const azar = opciones.azar || Math.random;
    const maxAgrandados = opciones.maxAgrandados ?? 6;
    const palabras = [...new Set(palabrasCrudas.map(limpiarPalabra))]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length); // las más largas primero: más fácil ubicarlas

    let tamano = tamanoInicial(palabras);

    for (let agrandado = 0; agrandado <= maxAgrandados; agrandado++) {
      const grilla = Array.from({ length: tamano }, () => Array(tamano).fill(''));
      const palabrasClave = [];
      let exito = true;

      for (const palabra of palabras) {
        const colocada = intentarColocar(grilla, tamano, palabra, azar);
        if (!colocada) { exito = false; break; }
        palabrasClave.push({ palabra, ...colocada });
      }

      if (exito) {
        for (let f = 0; f < tamano; f++) {
          for (let c = 0; c < tamano; c++) {
            if (!grilla[f][c]) grilla[f][c] = ALFABETO[Math.floor(azar() * ALFABETO.length)];
          }
        }
        return {
          filas: tamano,
          columnas: tamano,
          letras: grilla.map((fila) => fila.join('')),
          palabras_clave: palabrasClave,
        };
      }

      tamano += 2; // no entró alguna palabra: agrandamos la grilla y reintentamos desde cero
    }

    throw new Error(`No se pudo generar la grilla para [${palabras.join(', ')}] ni agrandándola ${maxAgrandados} veces.`);
  }

  return { generarGrilla, limpiarPalabra };
});
