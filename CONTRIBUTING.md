# Convenciones del equipo EduMatch

Estas reglas hacen que cada funcionalidad se pueda rastrear desde su tarjeta
hasta el código integrado en `main` (Guía del Entregable Final, secciones 6 y 9).
Aplican a todo el equipo, incluido el Scrum Master cuando desarrolla.

## 1. Ciclo de una tarea (APP-XX)

| Paso | Qué se hace | Evidencia |
|---|---|---|
| 1. Planeación | En el Sprint Planning la tarjeta APP-XX recibe responsable y etiqueta de Sprint. | Tarjeta asignada y acta en `01_Gestion`. |
| 2. Rama | El responsable crea la rama desde `main` y mueve la tarjeta a **En proceso**. | Rama `feature/APP-XX-...` en GitHub. |
| 3. Comunicación | Las dudas y decisiones se discuten en un hilo cuyo primer mensaje empieza con `[APP-XX]`. Si hubo llamada, se deja un resumen en el hilo. | Hilo en el canal y Daily. |
| 4. Commits | Commits pequeños y frecuentes con el código de la tarea. | Historial de la rama. |
| 5. Pull Request | PR hacia `main` con la plantilla; lo revisa **otro** integrante. | PR con revisor, comentarios y aprobación. |
| 6. Tablero | Tras el merge, la tarjeta pasa a **Completado** con enlaces al PR y al commit de cierre, y se actualiza la fila en la matriz de trazabilidad. | Tarjeta y matriz al día. |

## 2. Ramas

```bash
git checkout main
git pull origin main
git checkout -b feature/APP-05-busqueda-tutores
```

| Prefijo | Uso | Ejemplo |
|---|---|---|
| `feature/` | Nueva funcionalidad | `feature/APP-06-horario-ocupado` |
| `fix/` | Corrección de un error | `fix/APP-04-fecha-pasada` |
| `docs/` | Documentación | `docs/APP-00-readme` |
| `refactor/` | Mejorar el código sin cambiar su comportamiento | `refactor/APP-10-reasignacion` |
| `test/` | Pruebas | `test/APP-09-login` |
| `chore/` | Configuración y mantenimiento | `chore/APP-00-ci` |

Minúsculas, palabras separadas por guiones, sin tildes, eñes ni espacios.
Nadie trabaja directamente en `main`.

## 3. Commits

Formato [Conventional Commits](https://www.conventionalcommits.org/es/v1.0.0/):
`tipo(alcance): descripción. Refs APP-XX` en los commits intermedios y
`... Cierra APP-XX` en el que completa la tarea.

| Tipo | Uso | Ejemplo |
|---|---|---|
| `feat` | Nueva funcionalidad | `feat(agenda): impedir horarios ocupados. Cierra APP-06` |
| `fix` | Corrección | `fix(login): mensaje claro con contraseña vacía. Refs APP-09` |
| `docs` | Documentación | `docs(readme): instrucciones de instalación. Refs APP-00` |
| `style` | Formato sin cambiar lógica | `style(solicitudes): ordenar estilos. Refs APP-04` |
| `refactor` | Reorganizar código | `refactor(backend): extraer consulta de tutores. Refs APP-05` |
| `test` | Pruebas | `test(agenda): horario ocupado. Refs APP-06` |
| `chore` | Configuración, dependencias, CI | `chore: actualizar dependencias. Refs APP-00` |

No se aceptan mensajes como "cambios", "ya quedó" o "arreglos varios".

## 4. Pull Requests y revisión de código

- Título: `APP-XX · Nombre de la historia`. El cuerpo sigue la plantilla
  (`.github/pull_request_template.md`).
- Revisor: otro integrante. **Nadie aprueba ni hace merge de su propio PR.**
- El revisor lee el diff, prueba la rama y deja comentarios concretos
  (archivo, línea, por qué importa y qué propone). "Se ve bien" no es una revisión.
- Requisitos para el merge: 1 aprobación, check **Pruebas** en verde y sin
  conflictos. Se integra con **Create a merge commit** para conservar en `main`
  los commits con el código APP-XX.
- Plazo acordado de revisión: menos de 24 horas.

## 5. Definición de Terminado

Una tarjeta solo pasa a **Completado** si:

- [ ] Cumple todos sus criterios de aceptación, verificados por el Product Owner.
- [ ] El código se desarrolló en una rama con el código de la tarea.
- [ ] Los commits incluyen el código de la tarea.
- [ ] Fue revisado y aprobado en un Pull Request por otro integrante.
- [ ] Está integrado en `main`, `npm test` pasa y la app sigue funcionando.
- [ ] La tarjeta tiene enlaces al hilo de discusión, al diseño y al Pull Request.

## 6. Protección de `main` (la configura quien administra el repositorio)

GitHub › Settings › Branches › Add branch ruleset (o *Branch protection rule*) para `main`:

1. *Require a pull request before merging* con **1 aprobación**.
2. *Require status checks to pass* → seleccionar **pruebas**.
3. *Block force pushes* y no permitir eliminar la rama.

En repositorios privados de cuentas gratuitas estas reglas pueden no estar
disponibles: usar repositorio público o los beneficios de GitHub Education.

## 7. Claves y configuración

- Las claves de Supabase van en `.env` (ver `.env.example`), nunca en el código.
- Solo se usa la *publishable key*; la *secret key* no debe salir de Supabase.
- Cambios en la base de datos: nueva migración en `supabase/migrations/`
  con prefijo de fecha (`AAAAMMDDhhmmss_descripcion.sql`); nunca se edita una
  migración ya aplicada.
