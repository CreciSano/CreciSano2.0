# CreciSano

Plataforma de recetas saludables con lo que tienes en casa. React + Vite (cliente) y Express (API).

## Puesta en marcha

```bash
npm install            # genera package-lock.json: confírmalo en el repositorio
cp .env.example .env.local   # opcional; revisa cada variable
npm run dev            # desarrollo (Vite integrado, cuenta demo local)
npm test               # pruebas de seguridad
```

### Producción

```bash
npm ci
npm run build
npm start              # `--prod`: sirve dist/, sin Vite, sin cuenta demo, con CSP y HSTS
```

> `npm start` siempre arranca en modo producción. No ejecutes el modo desarrollo en un servidor público:
> expone el servidor de desarrollo de Vite.

## Seguridad: lo esencial

- **Informe completo:** [`INFORME_SEGURIDAD.md`](./INFORME_SEGURIDAD.md).
- **Datos:** `.data/` contiene correos y hashes de contraseña. Está en `.gitignore`; nunca lo subas,
  empaques ni compartas. Respáldalo con acceso restringido.
- **Secretos:** solo en variables de entorno (`.env.local`, ignorado por git). Nunca con prefijo `VITE_`.
- **Despliegue detrás de proxy** (Cloud Run, Nginx…): revisa `TRUST_PROXY` y `FRAME_ANCESTORS` en `.env.example`.
- **Una sola instancia:** la base JSON y el limitador de tasa viven en memoria del proceso.
  Para varias instancias, migra a una base de datos real y a un limitador compartido (ver informe, sección 4).

## Antes de cada despliegue

1. `npm test` (debe pasar al 100 %).
2. `npm run audit:prod` (sin vulnerabilidades altas/críticas).
3. `npm run build && grep -r "crecisano-demo" dist` → no debe devolver nada.
4. Revisa en el navegador (DevTools → Consola) que no haya violaciones de CSP.
