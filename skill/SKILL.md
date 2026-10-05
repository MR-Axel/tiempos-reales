---
name: tiempos-reales
description: Mide cuánto tiempo llevó de verdad cada tarea en cada proyecto, a partir de las transcripciones de Claude Code y del git, y arma un tablero para cotizar con esos números. La primera vez pregunta por los proyectos y el equipo de quien lo usa y lo deja configurado. Usar cuando alguien quiere saber cuánto tardó algo, cotizar un trabajo nuevo, o actualizar sus tiempos.
---

# Tiempos reales

Cotizar con datos propios y no con intuición. El script `tiempos.mjs` lee tres cosas, todas
en solo lectura y sin salir de la máquina: las transcripciones de Claude Code de esta
persona, el `git log` de sus repos y un `manual.csv` opcional. Devuelve horas por tarea y
por proyecto, y un `tablero.html` con cotizador.

## Dónde está la herramienta

Buscá la carpeta que tiene `tiempos.mjs` y `tablero.plantilla.html`. Si no la encontrás,
preguntá dónde la clonó. Todo lo que sigue se corre ahí.

## Primera vez: configurar con sus datos

Si no existe `config.json`, no inventes uno ni copies el de ejemplo tal cual: armalo con lo
que esta persona te diga y con lo que se ve en su máquina.

1. **Quién es.** Leé `git config --global user.name` y `user.email` y confirmá con qué
   nombre quiere figurar. Su patrón de persona tiene que reconocer ese nombre y ese mail,
   más los agentes que dispara: `^claude$|noreply@anthropic|gpt-engineer-app|^lovable|codex cli`.
2. **Dónde viven sus repos.** Por defecto `~/Documents/GitHub`. Si es otra carpeta, se pasa
   con `--repos`. Preguntá si tiene proyectos en algún otro lugar (escritorio, otra unidad)
   y cargalos en `raicesExtra`.
3. **Qué carpetas son qué proyecto.** Listá las carpetas de la carpeta de repos y mostrale
   la lista. Preguntá, proyecto por proyecto:
   - cómo se llama de cara a un cliente,
   - qué carpetas lo componen (el repo, la landing, los worktrees),
   - con qué palabras lo nombra cuando habla de él.
   Lo que sea una herramienta, una dependencia o una carpeta de pruebas va a
   `ignorarCarpetas`. Lo que no nombre queda como proyecto con el nombre de su carpeta.
4. **Con quién trabaja.** Si hay más gente con commits en esos repos, pedí nombre y cómo
   aparece en git (`git log --format='%an <%ae>' | sort | uniq -c` en un repo lo muestra).
   Quien no esté en la lista se ignora, que es lo correcto para autores de forks.
5. **Funcionalidades propias (opcional).** Si un proyecto tiene partes con nombre propio
   que quiere ver separadas, cada una va en `temas` con la tarea del catálogo a la que
   corresponde y las palabras que la identifican.

Escribí `config.json` con esas respuestas. El formato está en `config.ejemplo.json` y el
catálogo de tareas, con sus ids, en el README. Los patrones son expresiones regulares en
minúscula y sin tildes, porque el texto se compara normalizado.

## Cada vez: medir y mostrar

```
node tiempos.mjs
```

Tarda de segundos a unos minutos. Al terminar, contale el total, cuántas horas son medidas
y cuántas estimadas, y abrile `tablero.html`. Conviene correrlo una vez por semana: Claude
Code borra las transcripciones viejas y lo que no quedó en un informe se pierde.

## Para cotizar algo nuevo

1. Partí el pedido en tareas del catálogo, ítem por ítem.
2. Para cada una, usá el **promedio** de `catalogo.md`. Si se hizo una sola vez o la
   confianza es baja, decilo: es una referencia, no un número.
3. Mirá mínimo y máximo. Si el trabajo nuevo se parece al del máximo, arrancá de ahí.
4. Las horas medidas ya son trabajando con Claude Code. No les apliques otra vez un factor
   de aceleración.
5. Sumá colchón según quién maneja el reloj: 13 a 15 % si depende solo de quien cotiza,
   20 a 25 % si depende de un tercero (tiendas, dominios, cuentas ajenas).
6. En el tablero, la pestaña **Para compartir** arma la hoja para el cliente: títulos, horas
   y costo, sin nombres de otros proyectos ni historial.

## Lo que no hay que hacer

- No subas `config.json`, `manual.csv`, `catalogo.md`, `proyectos/` ni `tablero.html` a un
  repo público. Llevan los proyectos y las horas de esta persona, y ya están en el
  `.gitignore`.
- No copies texto de las transcripciones a ningún informe. El script solo usa fechas,
  carpetas y los primeros caracteres de cada mensaje para clasificar el tema.
- No presentes como medido lo que es estimado. Cada fila dice su confianza.
