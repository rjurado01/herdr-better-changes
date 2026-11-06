# Better Changes para Herdr

Versión personalizada del mod [better-changes](https://github.com/munza/herdr-mods/tree/main/better-changes). Incluye vista de diff, selección de líneas y envío de comentarios a sesiones de OpenCode del espacio actual, contexto ampliable y resaltado de sintaxis.

## Instalación

Copia `mods/better-changes/` a `~/.config/herdr-app/mods/better-changes/` **sin sobrescribir una instalación existente**. Para usarlo en un layout personal, configura un bloque con `{"mod": "better-changes", "props": {"mode": "sidebar"}}`. No modifiques directamente los layouts incluidos con Herdr.

Comprueba el mod con `herdr-app check ~/.config/herdr-app/mods/better-changes`.

## Comentarios

En el diff, selecciona una línea con un clic y, opcionalmente, el final del rango con otro. En vista dividida se envían los dos lados disponibles. Escribe el comentario y pulsa **Enviar a OpenCode**. Si hay varias sesiones de OpenCode en el espacio, elige una. El envío ejecuta `hc send` y requiere que el agente esté disponible.

## Licencias y procedencia

Basado en [munza/herdr-mods](https://github.com/munza/herdr-mods), bajo Apache 2.0: ver `LICENSE`. Esta versión modifica el comportamiento y la presentación del mod original.

`mods/better-changes/syntax.js` procede de [Herdr Annotator](https://github.com/jakub-tucek/herdr-annotator), bajo licencia MIT: ver `LICENSE-ANNOTATOR-MIT`.
