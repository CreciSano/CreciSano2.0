# Informe técnico de seguridad — CreciSano

**Alcance:** todo el contenido de `crecisano.zip` (cliente React, servidor Express, base de datos incluida, configuración y dependencias).
**Fecha:** 4 de noviembre de 2026.

## Resumen ejecutivo

La app tenía **4 problemas críticos**, **5 altos** y varios medios. Los más graves: contraseñas guardadas con SHA-256 sin sal, una credencial de demostración pública (en el código del cliente y dentro de la base de datos incluida en el zip), una vulnerabilidad de contaminación de prototipos explotable por cualquier usuario autenticado, y un `npm start` que levantaba el servidor de desarrollo de Vite, el cual permitía descargar la base de datos por URL.

Todo lo anterior está corregido en el código. Las 38 pruebas automatizadas pasan, y además verifiqué que fallan si se reintroducen dos de las vulnerabilidades originales.

---

## 1. Problemas encontrados y por qué eran riesgosos

### Críticos

| # | Problema | Dónde | Riesgo |
|---|---|---|---|
| C1 | **Contraseñas con SHA-256 sin sal**, comparadas con `!==` | `server.ts` `hashPassword` / login | Si se filtra la base, las contraseñas comunes se recuperan al instante (tablas precalculadas; dos usuarios con la misma clave tienen el mismo hash). La comparación no era de tiempo constante. |
| C2 | **Credencial demo pública** (`sofia@crecisano.com` / `crecisano123`) escrita en el cliente y sembrada en el servidor; además `.data/crecisano-db.json` **viajaba dentro del zip** (`.data/` no estaba en `.gitignore`) | `AuthAndProfile.tsx`, `server.ts`, `.data/` | Cualquiera podía iniciar sesión en la cuenta demo de un despliegue real. Verifiqué que el hash del zip (`085d4185…`) es exactamente `sha256("crecisano123")`. Una base de datos con correos y hashes no debe empaquetarse nunca. |
| C3 | **Contaminación de prototipos** en `PUT /api/meal-plan`: `mealPlans[id][day][slot] = recipeId` con `day` y `slot` sin validar | `server.ts` | Enviar `day: "__proto__"` escribía una propiedad en `Object.prototype` de todo el proceso (reproducido: `({}).isAdmin === 'true'`). Permite alterar la lógica de la app, provocar fallos o escalar a cosas peores según el código futuro. |
| C4 | **`npm start` ejecutaba el servidor de desarrollo de Vite** (`NODE_ENV` no se definía) y las imágenes dependían de rutas `/src/assets/...` que solo existen en ese modo | `package.json`, `server.ts` | El dev server de Vite sirve por URL los archivos de la raíz del proyecto; con la configuración original (`server.fs.deny` por defecto, que no cubre `.data/` ni `server.ts`) esto permitiría descargar `/.data/crecisano-db.json` (correos + hashes) y `/server.ts`. *(Comportamiento documentado de Vite; no pude ejecutarlo en mi entorno para reproducirlo.)* En cualquier caso, un servidor de desarrollo no debe estar expuesto en producción. |

### Altos

| # | Problema | Riesgo |
|---|---|---|
| A1 | **Sesiones débiles:** el token se guardaba **en claro** en la base, **sin expiración**, sin límite por usuario, y "cerrar sesión" solo borraba el token del navegador | Un token robado servía para siempre; filtrar la base equivalía a filtrar todas las sesiones activas. |
| A2 | **Sin límite de intentos** en ningún endpoint | Fuerza bruta de contraseñas sin freno, spam de registros, relleno de disco. |
| A3 | **Escritura anónima y suplantación:** crear recetas, comentar y dar "me gusta" sin cuenta (todos compartían el actor `guest`); el autor y la **imagen** de una receta se tomaban del cuerpo de la petición | Spam, suplantar a otro usuario (`authorName`), y poner URLs externas como imagen (rastreo de la IP de cada visitante, contenido ajeno). |
| A4 | **Sin validación de entradas:** arrays y objetos arbitrarios aceptados tal cual, tamaño de cuerpo hasta 2 MB, contraseña mínima de **4** caracteres, sin límites de longitud | Inflado de la base de datos, datos corruptos, texto con caracteres de control o de dirección Unicode (falsificación visual), contraseñas triviales. |
| A5 | **Persistencia frágil:** la base se releía y reescribía completa en cada petición, sin escritura atómica ni permisos; si el JSON se corrompía, **se sobrescribía silenciosamente con los datos de ejemplo** | Pérdida total de datos ante un corte a mitad de escritura, y reaparición automática de la cuenta demo pública. Archivo legible por otros usuarios del sistema. |

### Medios y bajos

- **M1** Sin cabeceras de seguridad (CSP, `nosniff`, anti-iframe, `Referrer-Policy`…) y `X-Powered-By` expuesto.
- **M2** Enumeración de cuentas por diferencia de tiempos (usuario inexistente respondía más rápido que contraseña incorrecta).
- **M3** Errores de parseo/500 sin manejador propio (riesgo de filtrar trazas en entornos mal configurados).
- **M4** `likedBy` devolvía los ids internos de otros usuarios a cualquiera.
- **M5** Ids de solo 32 bits (`randomUUID().slice(0,8)`): colisiones posibles.
- **M6** Cadena de suministro: dependencia sin uso (`@google/genai`), `tsx` en `devDependencies` pese a usarse en `npm start`, y **sin `package-lock.json`**.
- **M7** El servidor escucha en `0.0.0.0` sin posibilidad de configurarlo.
- **B1** (residual, no corregido) Token de sesión en `localStorage`: si algún día hubiera XSS, sería robable. Hoy no hay `dangerouslySetInnerHTML` ni `innerHTML` en el cliente y React escapa el contenido, pero véase el punto 4b.
- **B2** Google Fonts se carga desde un tercero (envía la IP del visitante a Google).

---

## 2. Cambios aplicados

**Servidor (reescrito y modularizado: `server.ts`, `server/app.ts`, `server/security.ts`, `server/db.ts`)**

- **Contraseñas:** scrypt con sal aleatoria por usuario y parámetros OWASP (N=2¹⁵, r=8, p=3), asíncrono (no bloquea el servidor), comparación en tiempo constante. Los hashes SHA-256 antiguos siguen funcionando **solo para migrar**: se reconvierten a scrypt en el siguiente inicio de sesión correcto. Política: 10–128 caracteres, bloquea claves comunes/repetidas e iguales al correo.
- **Cuenta demo:** ya no existe en producción. En desarrollo se siembra con otra contraseña y el botón del cliente solo se compila en modo `DEV` (se elimina del bundle de producción). Si una base heredada contiene la credencial pública antigua, **se deshabilita automáticamente** al arrancar en producción.
- **Sesiones:** token de 256 bits; en disco solo su hash SHA-256; caducan a los 7 días; máximo 10 por usuario; nuevo `POST /api/auth/logout` que las invalida en el servidor; limpieza periódica. Las sesiones heredadas (token en claro) se invalidan todas en la migración.
- **Autenticación obligatoria** para publicar recetas, comentar, dar "me gusta", favoritos, planificador y perfil. Autor, imagen e id **ya no se aceptan del cliente**.
- **Prototype pollution:** `day` y `slot` se validan contra listas blancas; la receta debe existir; los ids deben cumplir un formato seguro (`isSafeId`).
- **Validación estricta** de todo lo que entra: tipos, longitudes, cantidades (p. ej. ≤40 ingredientes, ≤500 caracteres por comentario), categorías contra la lista oficial, eliminación de caracteres de control y de dirección Unicode. Cuerpo máximo de 2 MB → **32 KB**.
- **Límites de tasa:** login (por IP+correo, por IP y por correo, contando solo fallos), registro (5/hora/IP), publicar recetas (10/hora/usuario), comentarios, likes, escrituras y límite global por IP. Memoria acotada.
- **Anti-enumeración:** mismo mensaje y mismo tiempo para "usuario inexistente" y "contraseña incorrecta".
- **Cabeceras:** CSP estricta en producción (`script-src 'self'`, `object-src 'none'`, `frame-ancestors`…), HSTS, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP/CORP, `Cache-Control: no-store` en `/api`, sin `X-Powered-By`.
- **Protección same-origin** para peticiones que modifican datos (defensa en profundidad contra CSRF/uso desde otros sitios).
- **Producción real:** `npm start` ahora usa `--prod`; Vite se carga de forma dinámica **solo en desarrollo**; si falta `dist/` el servidor se niega a arrancar; las rutas `/api/*` desconocidas devuelven 404 JSON (nunca el `index.html`).
- **Base de datos:** carga única en memoria, escritura **atómica** (archivo temporal + `fsync` + `rename`), permisos `0700/0600`, y ante un JSON corrupto **se aparta el archivo y se detiene el arranque** en vez de sobrescribirlo. Migración automática de datos antiguos.
- **Errores:** manejador central; el cliente nunca recibe trazas, y los logs no incluyen cuerpos, contraseñas ni correos.
- **Otros:** ids con UUID completo; `likedBy` ya no revela ids ajenos; `HOST`, `TRUST_PROXY`, `FRAME_ANCESTORS`, `ALLOWED_ORIGINS`, `DATA_DIR` configurables; apagado ordenado.

**Cliente**

- Botón y credenciales demo solo en desarrollo; formularios con `maxLength`, `minLength` y `autocomplete` correctos (gestores de contraseñas).
- Cerrar sesión ahora invalida el token en el servidor; si la sesión caduca se pide iniciar sesión de nuevo; like/comentar/publicar redirigen a iniciar sesión si no la hay; las respuestas no-JSON ya no rompen el flujo.
- Imágenes movidas de `src/assets/images` a `public/assets/images` y rutas actualizadas (necesario para que funcionen en producción sin el dev server).

**Proyecto y dependencias**

- `.data/` eliminado del paquete y agregado a `.gitignore` (junto con `*.pem`, `*.key`, `*.corrupt-*`).
- `vite.config.ts`: el dev server ya no puede servir `.data/`, `.env*`, `server.ts` ni el código del servidor.
- `package.json`: eliminado `@google/genai` (sin uso), `tsx` movido a `dependencies`, `engines`, y scripts `test` y `audit:prod`.
- `.env.example` reescrito y documentado (incluye la advertencia de no usar el prefijo `VITE_` para secretos).

---

## 3. Cambios para mantener la app segura a futuro

- **38 pruebas automatizadas** (`npm test`, en `test/`): hashing, migraciones, validación, límites de tasa, persistencia, autorización, prototype pollution, suplantación de autor/imagen, fuerza bruta, cabeceras, sesiones caducadas y cross-origin. Convertidas en una red de seguridad: si alguien reintroduce un fallo, la prueba falla.
- `npm run audit:prod` para detectar dependencias vulnerables; checklist previa al despliegue en el `README`.
- Lógica de seguridad **centralizada y sin dependencias externas** (`server/security.ts`), con lo que hay menos superficie de cadena de suministro y un único lugar donde auditar.
- Valores por defecto seguros: producción por defecto en `npm start`, seed sin cuentas en producción, límites y topes (usuarios, recetas, comentarios, favoritos) para evitar abuso y llenado de disco.
- Registro de eventos de seguridad (`auth.login_failed`, `auth.register`, errores) sin datos personales, útil para alertas.
- Documentación operativa en `README.md` y `.env.example`.

---

## 4. Mejoras que NO apliqué porque implican cambios importantes (necesito tu aprobación)

| | Mejora | Por qué conviene | Impacto |
|---|---|---|---|
| a | **Migrar el JSON a SQLite/PostgreSQL** | Transacciones reales, backups, cifrado en reposo, y habilita más de una instancia. Hoy la app **debe correr en una sola instancia** (la base y el limitador viven en memoria del proceso). | Reescribir la capa `server/db.ts`; migrar datos. |
| b | **Sesión en cookie `HttpOnly; Secure; SameSite`** (+ token CSRF) en lugar de `localStorage` | Elimina el robo de token ante un eventual XSS. | Cambia el flujo de auth del cliente y del servidor. |
| c | **Verificación de correo, recuperación/cambio de contraseña, borrado y exportación de cuenta, 2FA opcional** | Hoy se puede registrar un correo ajeno y no hay forma de restablecer claves; además es relevante para privacidad (datos personales). | Nuevas pantallas, un servicio de envío de correo y nuevos secretos. |
| d | **Alojar las fuentes localmente** | Quita a Google de la CSP y evita enviarle la IP de cada visitante. | Añadir los archivos de fuente al proyecto. |
| e | **Moderación de la comunidad** (reportar/ocultar) y, si se desean fotos propias, subida con validación y re-codificación de imágenes | El contenido público no tiene control humano. | Nueva funcionalidad. |
| f | Activar `"strict": true` en `tsconfig.json` | Detecta más errores en compilación. | Corregir los errores de tipos que aparezcan en el cliente. |

**Cambios de comportamiento que sí apliqué y debes conocer:** los invitados ya no pueden dar "me gusta", comentar ni publicar (se les lleva a iniciar sesión); la contraseña mínima pasa a 10 caracteres; las sesiones caducan a los 7 días y **todas las anteriores se cerraron**; la cuenta demo solo existe en desarrollo y su contraseña cambió a `crecisano-demo-local`; `likedBy` ya no incluye ids de otras personas.

---

## 5. Acciones que debes hacer tú

1. **Si esta app estuvo desplegada o el zip se compartió:** considera comprometido todo lo que contenía. La cuenta `sofia@crecisano.com` queda deshabilitada automáticamente en producción; para **usuarios reales**, sus hashes SHA-256 antiguos eran fáciles de revertir, así que pídeles restablecer su contraseña (se re-hashean solos al próximo login, pero eso no protege copias ya filtradas).
2. **Rotar la clave de Gemini** si alguna vez estuvo en un `.env` compartido (en el zip solo había un marcador de posición; hoy el código tampoco la usa).
3. Ejecutar `npm install`, **commitear `package-lock.json`**, y correr `npm test`, `npm run audit:prod` y `npm run build`.
4. Detrás de proxy (Cloud Run, etc.): confirmar `TRUST_PROXY` y, si la incrustas en otro sitio (p. ej. vista previa de AI Studio), añadir su origen en `FRAME_ANCESTORS`.
5. Servir siempre por **HTTPS** y respaldar `.data/` con acceso restringido.

---

## 6. Limitaciones de esta revisión (transparencia)

- Mi entorno **no tenía acceso a internet**: no pude instalar `express` ni `vite` reales, ejecutar `npm audit`, hacer el `build` del cliente ni probar en un navegador. Validé el servidor con un `express` simulado (solo para pruebas, no incluido), verificación de tipos en modo estricto del servidor y una prueba de arranque en modo producción. Las 38 pruebas están escritas para funcionar igual con el `express` real; **conviene correrlas tras `npm install`.**
- **Pendiente de verificar en navegador:** que la CSP de producción no bloquee nada (fuentes, estilos). Si aparece algún bloqueo, se ajusta en `securityHeaders` (`server/security.ts`).
- No reproduje en vivo la descarga de `.data/` en el dev server de Vite original (ver C4); la corrección es válida igualmente porque `npm start` ya no lo usa y `vite.config.ts` bloquea esas rutas.
- No pude comprobar que las versiones del `package.json` (p. ej. Vite 8, TypeScript 7) existan en el registro ni auditarlas.
- No revisé la infraestructura de despliegue (red, secretos del hosting, backups), solo el código entregado.
