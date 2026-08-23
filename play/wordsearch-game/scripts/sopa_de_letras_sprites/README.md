# Sprites — Sopa de Letras

Todo en SVG (vector, escalable a cualquier tamaño sin perder calidad).

## Estructura

```
icons/        55 iconos de categoria, en formato circular (badge)
              - <clave>.svg              -> version por defecto (tono verde)
              - <clave>__facil.svg
              - <clave>__medio.svg
              - <clave>__dificil.svg
              - <clave>__extremo.svg      -> mismas variantes, coloreadas segun dificultad
ui/
  locked_badge.svg        -> nodo bloqueado (candado) para el mapa de niveles
  star_filled.svg         -> estrella de progreso, llena
  star_empty.svg          -> estrella de progreso, vacia
  button_jugar.svg         -> boton principal (naranja)
  button_opciones.svg      -> boton secundario (purpura)
  button_creditos.svg      -> boton secundario (purpura)
  background_stars.svg     -> fondo espacial 800x1400 con estrellas (algunas titilan)
  connector_locked.svg      -> linea punteada gris (tramo bloqueado del mapa)
  connector_unlocked.svg    -> linea punteada verde (tramo desbloqueado)
mapping.json               -> mapeo completo: los 100 niveles -> tematica -> icono
preview_icons.png           -> hoja de contacto para revisar todos los iconos
preview_ui.png / preview_buttons.png / preview_background.png
```

## Sobre los 55 iconos de categoria

Tenes 100 niveles con muchas tematicas repetidas o muy parecidas entre si
(por ejemplo "Ciencia" y "Ciencia avanzada", o "Animales", "Animales salvajes"
y "Animales marinos"). En vez de hacer 100 iconos identicos, se agruparon en
55 conceptos visuales unicos y `mapping.json` linkea cada uno de los 100
niveles a su icono correspondiente. Asi:

```json
{
  "nivel": 27,
  "dificultad": "medio",
  "tematica": "Frutas tropicales",
  "icono": "frutas",
  "archivo_icono": "icons/frutas.svg",
  "color_dificultad": "#2fb6c4"
}
```

`color_dificultad` es el color solido de esa dificultad (verde=facil,
celeste=medio, violeta=dificil, rojo=extremo) por si preferis tintar el
icono/anillo en tiempo de ejecucion en vez de usar los archivos
`__facil/__medio/__dificil/__extremo` ya generados.

## Estilo

Coincide con las capturas que mandaste: fondo circular con degradado,
brillo superior tipo "glossy", anillo mas oscuro, glifo blanco centrado.
Los botones y el fondo usan la misma paleta navy/purpura + naranja de la
pantalla de menu.

## Integrar en el juego

- Como son SVG, se pueden usar directo en web/CSS (`background-image`),
  en motores como Godot/Unity (importan SVG o los podes rasterizar a PNG
  con cualquier conversor, incluido cairosvg/Inkscape), o en React Native
  con `react-native-svg`.
- Si necesitas PNG a una resolucion fija, avisame el tamaño (ej. 256x256,
  512x512) y te los exporto todos.
