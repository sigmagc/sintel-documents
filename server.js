// server.js - Servidor principal para Render con Panel de Administración
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuración de PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Inicializar base de datos
async function initializeDatabase() {
    try {
        // Tabla para contadores
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sintel_counters (
                id SERIAL PRIMARY KEY,
                department VARCHAR(10) NOT NULL,
                document_type VARCHAR(20) NOT NULL,
                counter INTEGER DEFAULT 0,
                year INTEGER NOT NULL,
                UNIQUE(department, document_type, year)
            )
        `);

        // Tabla para documentos
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sintel_documents (
                id SERIAL PRIMARY KEY,
                document_number VARCHAR(100) UNIQUE NOT NULL,
                document_type VARCHAR(20) NOT NULL,
                department VARCHAR(10) NOT NULL,
                subject TEXT NOT NULL,
                recipient VARCHAR(255),
                content TEXT,
                created_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                status VARCHAR(20) DEFAULT 'Activo'
            )
        `);

        console.log('Base de datos inicializada correctamente');
    } catch (err) {
        console.error('Error inicializando base de datos:', err);
    }
}

// Función auxiliar para asegurar que existe el contador
async function ensureCounter(department, type, year) {
    try {
        // Intentar insertar el contador si no existe
        await pool.query(
            `INSERT INTO sintel_counters (department, document_type, counter, year) 
             VALUES ($1, $2, 0, $3) 
             ON CONFLICT (department, document_type, year) 
             DO NOTHING`,
            [department, type, year]
        );
    } catch (err) {
        console.error('Error asegurando contador:', err);
    }
}

// ================================
// RUTAS PRINCIPALES
// ================================

// Obtener próximo número de documento
app.get('/api/next-number/:type/:department', async (req, res) => {
    try {
        const { type, department } = req.params;
        const currentYear = new Date().getFullYear();

        // Asegurar que existe el contador
        await ensureCounter(department, type, currentYear);

        // Obtener contador actual
        const counterResult = await pool.query(
            'SELECT counter FROM sintel_counters WHERE department = $1 AND document_type = $2 AND year = $3',
            [department, type, currentYear]
        );

        if (counterResult.rows.length === 0) {
            throw new Error('No se pudo obtener el contador');
        }

        const nextNumber = counterResult.rows[0].counter + 1;
        const paddedNumber = String(nextNumber).padStart(3, '0');
        const documentTypes = {
    'oficio': 'Oficio No.',
    'memorando': 'Memorando No.',
    'orden_compra': 'Orden de Compra No.',
    'proforma': 'Proforma No.',
    'acta_entrega': 'Acta de Entrega No.',
    'acta_recepcion': 'Acta de Recepción No.'
};
const prefix = documentTypes[type] || 'Documento No.';
        const documentNumber = `${prefix}SINTEL-${department}-${paddedNumber}-${currentYear}`;

        res.json({ documentNumber, nextNumber });
    } catch (err) {
        console.error('Error obteniendo próximo número:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Generar documento
app.post('/api/generate-document', async (req, res) => {
    try {
        const { type, department, subject, recipient, content } = req.body;
        const currentYear = new Date().getFullYear();

        // Validar datos requeridos
        if (!type || !department || !subject) {
            return res.status(400).json({ 
                error: 'Faltan datos requeridos: type, department, subject' 
            });
        }

        // Asegurar que existe el contador
        await ensureCounter(department, type, currentYear);

        // Incrementar contador en una transacción
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');

            // Incrementar contador
            await client.query(
                `UPDATE sintel_counters 
                 SET counter = counter + 1 
                 WHERE department = $1 AND document_type = $2 AND year = $3`,
                [department, type, currentYear]
            );

            // Obtener nuevo número
            const counterResult = await client.query(
                'SELECT counter FROM sintel_counters WHERE department = $1 AND document_type = $2 AND year = $3',
                [department, type, currentYear]
            );

            if (counterResult.rows.length === 0) {
                throw new Error('Error obteniendo contador después de incrementar');
            }

            const currentNumber = counterResult.rows[0].counter;
            const paddedNumber = String(currentNumber).padStart(3, '0');
            const documentTypes = {
    'oficio': 'Oficio No.',
    'memorando': 'Memorando No.',
    'orden_compra': 'Orden de Compra No.',
    'proforma': 'Proforma No.',
    'acta_entrega': 'Acta de Entrega No.',
    'acta_recepcion': 'Acta de Recepción No.'
};
const prefix = documentTypes[type] || 'Documento No.';
            const documentNumber = `${prefix}SINTEL-${department}-${paddedNumber}-${currentYear}`;

            // Guardar documento
            await client.query(
                `INSERT INTO sintel_documents 
                 (document_number, document_type, department, subject, recipient, content) 
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [documentNumber, type, department, subject, recipient || '', content || '']
            );

            await client.query('COMMIT');

            res.json({
                success: true,
                documentNumber,
                message: 'Documento generado exitosamente'
            });

        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }

    } catch (err) {
        console.error('Error generando documento:', err);
        res.status(500).json({ 
            error: 'Error generando documento',
            details: err.message 
        });
    }
});

// Obtener historial de documentos
app.get('/api/documents', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, document_number, document_type, department, subject, 
                    recipient, created_date, status 
             FROM sintel_documents 
             ORDER BY created_date DESC 
             LIMIT 50`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error obteniendo documentos:', err);
        res.status(500).json({ error: 'Error obteniendo documentos' });
    }
});

// Obtener estadísticas
app.get('/api/stats', async (req, res) => {
    try {
        const totalDocsResult = await pool.query('SELECT COUNT(*) as total FROM sintel_documents');
        
        const todayDocsResult = await pool.query(
            `SELECT COUNT(*) as today 
             FROM sintel_documents 
             WHERE DATE(created_date) = CURRENT_DATE`
        );

        const activeDeptResult = await pool.query(
            `SELECT COUNT(DISTINCT department) as active 
             FROM sintel_documents 
             WHERE created_date >= CURRENT_DATE - INTERVAL '30 days'`
        );

        res.json({
            totalDocuments: parseInt(totalDocsResult.rows[0].total),
            todayDocuments: parseInt(todayDocsResult.rows[0].today),
            activeDepartments: parseInt(activeDeptResult.rows[0].active)
        });
    } catch (err) {
        console.error('Error obteniendo estadísticas:', err);
        res.status(500).json({ error: 'Error obteniendo estadísticas' });
    }
});

// ================================
// RUTAS DE ADMINISTRACIÓN
// ================================

// ELIMINAR DOCUMENTO ESPECÍFICO
app.delete('/api/delete-document/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Obtener documento antes de eliminar
        const docResult = await pool.query(
            'SELECT * FROM sintel_documents WHERE id = $1',
            [id]
        );

        if (docResult.rows.length === 0) {
            return res.status(404).json({ error: 'Documento no encontrado' });
        }

        const document = docResult.rows[0];

        // Eliminar documento
        await pool.query('DELETE FROM sintel_documents WHERE id = $1', [id]);

        // Decrementar contador correspondiente
        const currentYear = new Date(document.created_date).getFullYear();
        await pool.query(
            `UPDATE sintel_counters 
             SET counter = GREATEST(counter - 1, 0)
             WHERE department = $1 AND document_type = $2 AND year = $3`,
            [document.department, document.document_type, currentYear]
        );

        res.json({
            success: true,
            message: `Documento ${document.document_number} eliminado correctamente`
        });
    } catch (err) {
        console.error('Error eliminando documento:', err);
        res.status(500).json({ error: 'Error eliminando documento' });
    }
});

// ELIMINAR TODOS LOS DOCUMENTOS
app.delete('/api/delete-all-documents', async (req, res) => {
    try {
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            
            // Contar documentos antes de eliminar
            const countResult = await client.query('SELECT COUNT(*) as total FROM sintel_documents');
            const totalDeleted = parseInt(countResult.rows[0].total);
            
            // Eliminar todos los documentos
            await client.query('DELETE FROM sintel_documents');
            
            // Resetear todos los contadores a 0
            await client.query('UPDATE sintel_counters SET counter = 0');
            
            await client.query('COMMIT');
            
            res.json({
                success: true,
                message: `${totalDeleted} documentos eliminados y contadores reiniciados`
            });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Error eliminando todos los documentos:', err);
        res.status(500).json({ error: 'Error eliminando documentos' });
    }
});

// REINICIAR CONTADOR ESPECÍFICO
app.post('/api/reset-counter', async (req, res) => {
    try {
        const { department, document_type, year } = req.body;
        
        if (!department || !document_type || !year) {
            return res.status(400).json({ 
                error: 'Faltan parámetros: department, document_type, year' 
            });
        }

        // Resetear contador específico
        const result = await pool.query(
            `UPDATE sintel_counters 
             SET counter = 0 
             WHERE department = $1 AND document_type = $2 AND year = $3`,
            [department, document_type, year]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Contador no encontrado' });
        }

        res.json({
            success: true,
            message: `Contador ${document_type} para ${department} ${year} reiniciado`
        });
    } catch (err) {
        console.error('Error reiniciando contador:', err);
        res.status(500).json({ error: 'Error reiniciando contador' });
    }
});

// REINICIAR TODOS LOS CONTADORES
app.post('/api/reset-all-counters', async (req, res) => {
    try {
        await pool.query('UPDATE sintel_counters SET counter = 0');
        
        res.json({
            success: true,
            message: 'Todos los contadores han sido reiniciados a 0'
        });
    } catch (err) {
        console.error('Error reiniciando contadores:', err);
        res.status(500).json({ error: 'Error reiniciando contadores' });
    }
});

// OBTENER INFORMACIÓN DE CONTADORES
app.get('/api/counters', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT department, document_type, counter, year 
             FROM sintel_counters 
             ORDER BY year DESC, department, document_type`
        );
        
        res.json(result.rows);
    } catch (err) {
        console.error('Error obteniendo contadores:', err);
        res.status(500).json({ error: 'Error obteniendo contadores' });
    }
});

// ================================
// RUTAS ESTÁTICAS
// ================================

// Servir página principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================================
// INICIALIZAR SERVIDOR
// ================================

async function startServer() {
    await initializeDatabase();
    app.listen(port, () => {
        console.log(`Servidor SINTEL ejecutándose en puerto ${port}`);
    });
}

startServer();
