-- EduMatch — Modelo relacional para MySQL Workbench
-- Uso: modelo académico/local. La app conectada a Supabase usa PostgreSQL + Auth.

CREATE DATABASE IF NOT EXISTS edumatch
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
USE edumatch;

CREATE TABLE usuarios (
    id CHAR(36) PRIMARY KEY,
    nombre VARCHAR(120) NOT NULL,
    correo VARCHAR(180) NOT NULL UNIQUE,
    contrasena_hash VARCHAR(255) NULL,
    rol ENUM('Estudiante','Tutor') NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE materias (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    nombre VARCHAR(160) NOT NULL UNIQUE,
    categoria VARCHAR(80) NOT NULL,
    descripcion TEXT,
    creada_por CHAR(36) NULL,
    creada_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_materia_creador FOREIGN KEY (creada_por) REFERENCES usuarios(id) ON DELETE SET NULL
);

CREATE TABLE tutor_materias (
    tutor_id CHAR(36) NOT NULL,
    materia_id BIGINT NOT NULL,
    PRIMARY KEY (tutor_id, materia_id),
    CONSTRAINT fk_tm_tutor FOREIGN KEY (tutor_id) REFERENCES usuarios(id) ON DELETE CASCADE,
    CONSTRAINT fk_tm_materia FOREIGN KEY (materia_id) REFERENCES materias(id) ON DELETE CASCADE
);

CREATE TABLE solicitudes_tutoria (
    id BIGINT PRIMARY KEY,
    estudiante_id CHAR(36) NOT NULL,
    tutor_id CHAR(36) NULL,
    materia_id BIGINT NOT NULL,
    fecha_preferida DATE NOT NULL,
    hora_preferida TIME NOT NULL,
    tema TEXT NULL,
    estado ENUM('pendiente','aceptada','rechazada','propuesta_horario','cancelada','realizada') NOT NULL DEFAULT 'pendiente',
    fecha_propuesta DATE NULL,
    hora_propuesta TIME NULL,
    mensaje_propuesta TEXT NULL,
    origen_rechazo VARCHAR(30) NULL,
    fecha_propuesta_rechazada DATE NULL,
    hora_propuesta_rechazada TIME NULL,
    motivo_cancelacion VARCHAR(50) NULL,
    abierta_reasignacion BOOLEAN NOT NULL DEFAULT FALSE,
    oculta_para_estudiante BOOLEAN NOT NULL DEFAULT FALSE,
    oculta_para_tutor BOOLEAN NOT NULL DEFAULT FALSE,
    respondida_en TIMESTAMP NULL,
    realizada_en TIMESTAMP NULL,
    creada_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizada_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_sol_estudiante FOREIGN KEY (estudiante_id) REFERENCES usuarios(id),
    CONSTRAINT fk_sol_tutor FOREIGN KEY (tutor_id) REFERENCES usuarios(id) ON DELETE SET NULL,
    CONSTRAINT fk_sol_materia FOREIGN KEY (materia_id) REFERENCES materias(id)
);

CREATE TABLE solicitud_tutores_rechazados (
    solicitud_id BIGINT NOT NULL,
    tutor_id CHAR(36) NOT NULL,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (solicitud_id, tutor_id),
    CONSTRAINT fk_str_solicitud FOREIGN KEY (solicitud_id) REFERENCES solicitudes_tutoria(id) ON DELETE CASCADE,
    CONSTRAINT fk_str_tutor FOREIGN KEY (tutor_id) REFERENCES usuarios(id) ON DELETE CASCADE
);

CREATE TABLE historial_solicitud (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    solicitud_id BIGINT NOT NULL,
    tipo VARCHAR(50) NOT NULL,
    fecha_evento TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    detalles JSON NULL,
    CONSTRAINT fk_hist_solicitud FOREIGN KEY (solicitud_id) REFERENCES solicitudes_tutoria(id) ON DELETE CASCADE
);

CREATE TABLE calificaciones (
    solicitud_id BIGINT PRIMARY KEY,
    estudiante_id CHAR(36) NOT NULL,
    tutor_id CHAR(36) NULL,
    puntuacion TINYINT NOT NULL,
    comentario TEXT NULL,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT chk_calificacion CHECK (puntuacion BETWEEN 1 AND 5),
    CONSTRAINT fk_cal_solicitud FOREIGN KEY (solicitud_id) REFERENCES solicitudes_tutoria(id) ON DELETE CASCADE,
    CONSTRAINT fk_cal_estudiante FOREIGN KEY (estudiante_id) REFERENCES usuarios(id),
    CONSTRAINT fk_cal_tutor FOREIGN KEY (tutor_id) REFERENCES usuarios(id) ON DELETE SET NULL
);

INSERT INTO materias (id, nombre, categoria, descripcion) VALUES
(1, 'Cálculo Diferencial', 'Matemáticas', 'Límites, derivadas, optimización y sus aplicaciones en ingeniería.'),
(2, 'Programación Orientada a Objetos', 'Sistemas', 'Clases, objetos, herencia, polimorfismo y patrones de diseño.'),
(3, 'Física Mecánica', 'Física', 'Leyes de Newton, conservación de la energía, momento y cinemática.'),
(4, 'Estructuras de Datos', 'Sistemas', 'Listas enlazadas, árboles binarios, grafos y análisis de algoritmos.'),
(5, 'Álgebra Lineal', 'Matemáticas', 'Vectores, matrices, espacios vectoriales y transformaciones lineales.'),
(6, 'Bases de Datos', 'Sistemas', 'Modelado relacional, SQL, normalización y gestión de datos.')
ON DUPLICATE KEY UPDATE
    categoria = VALUES(categoria),
    descripcion = VALUES(descripcion);
