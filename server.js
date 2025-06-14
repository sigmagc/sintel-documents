const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuración de la base de datos Supabase usando DATABASE_URL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    },
    // Forzar IPv4 para evitar problemas de conectividad
    family: 4,
    // Configuraciones adicionales para mejorar la conexión
    connectionTimeoutMillis: 30000,
    idleTimeoutMillis: 30000,
    max: 20
});

// Verificar conexión a la base de datos
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Error conectando a Supabase:', err);
    } else {
        console.log('✅ Conectado exitosamente a Supabase');
        release();
    }
});

// ================================
// RUTAS DEL API
// ================================

// Ruta principal - servir el HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Generar nuevo documento
app.post('/api/documents', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const { type, department, subject, recipient, content, created_by, created_by_role } = req.body;
        
        // Obtener el próximo número de documento usando la función de la base de datos
        const numberResult = await client.query(
            'SELECT get_next_document_number($1, $2) as document_number',
            [department, type]
        );
        
        const documentNumber = numberResult.rows[0].document_number;
        
        // Insertar el documento
        const insertResult = await client.query(
            `INSERT INTO documents (document_number, document_type, department, subject, recipient, content, created_by, created_by_role)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [documentNumber, type, department, subject, recipient || '', content || '', created_by, created_by_role]
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            documentNumber: documentNumber,
            id: insertResult.rows[0].id,
            message: 'Documento generado exitosamente'
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error generando documento:', error);
        res.status(500).json({
            success: false,
            message: 'Error generando documento: ' + error.message
        });
    } finally {
        client.release();
    }
});

// Obtener todos los documentos (historial)
app.get('/api/documents', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM documents ORDER BY created_date DESC'
        );
        
        res.json(result.rows);
    } catch (error) {
        console.error('❌ Error obteniendo documentos:', error);
        res.status(500).json({
            success: false,
            message: 'Error obteniendo documentos: ' + error.message
        });
    }
});

// Obtener estadísticas
app.get('/api/stats', async (req, res) => {
    try {
        // Total de documentos
        const totalResult = await pool.query('SELECT COUNT(*) as total FROM documents');
        
        // Documentos de hoy
        const todayResult = await pool.query(
            `SELECT COUNT(*) as today FROM documents 
             WHERE DATE(created_date) = CURRENT_DATE`
        );
        
        // Departamentos activos
        const deptsResult = await pool.query(
            'SELECT COUNT(DISTINCT department) as departments FROM documents'
        );
        
        res.json({
            totalDocuments: parseInt(totalResult.rows[0].total),
            todayDocuments: parseInt(todayResult.rows[0].today),
            activeDepartments: parseInt(deptsResult.rows[0].departments)
        });
    } catch (error) {
        console.error('❌ Error obteniendo estadísticas:', error);
        res.status(500).json({
            success: false,
            message: 'Error obteniendo estadísticas: ' + error.message
        });
    }
});

// Obtener próximo número de documento (preview)
app.get('/api/preview-number', async (req, res) => {
    try {
        const { type, department } = req.query;
        
        if (!type || !department) {
            return res.status(400).json({
                success: false,
                message: 'Tipo y departamento son requeridos'
            });
        }
        
        // Obtener el contador actual sin incrementar
        const year = new Date().getFullYear();
        const result = await pool.query(
            'SELECT counter FROM counters WHERE department = $1 AND document_type = $2 AND year = $3',
            [department, type, year]
        );
        
        const currentCounter = result.rows.length > 0 ? result.rows[0].counter : 0;
        const nextNumber = currentCounter + 1;
        
        // Construir el número de documento
        const prefixes = {
            'oficio': 'Oficio No.',
            'memorando': 'Memorando No.',
            'orden_compra': 'Orden de Compra No.',
            'proforma': 'Proforma No.',
            'acta_entrega_externa': 'Acta de Entrega-Recepción Externa No.',
            'acta_entrega_interna': 'Acta de Entrega-Recepción Interna No.',
            'acta_reunion': 'Acta de Reunión No.'
        };
        
        const prefix = prefixes[type] || 'Documento No.';
        const documentNumber = `${prefix} ${department}-${String(nextNumber).padStart(3, '0')}-${year}`;
        
        res.json({
            success: true,
            nextNumber: documentNumber
        });
    } catch (error) {
        console.error('❌ Error obteniendo próximo número:', error);
        res.status(500).json({
            success: false,
            message: 'Error obteniendo próximo número: ' + error.message
        });
    }
});

// Obtener contadores (solo para administradores)
app.get('/api/counters', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM counters ORDER BY department, document_type'
        );
        
        res.json(result.rows);
    } catch (error) {
        console.error('❌ Error obteniendo contadores:', error);
        res.status(500).json({
            success: false,
            message: 'Error obteniendo contadores: ' + error.message
        });
    }
});

// Eliminar documento (solo administradores)
app.delete('/api/documents/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const result = await pool.query(
            'DELETE FROM documents WHERE id = $1 RETURNING document_number',
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Documento no encontrado'
            });
        }
        
        res.json({
            success: true,
            message: `Documento ${result.rows[0].document_number} eliminado correctamente`
        });
    } catch (error) {
        console.error('❌ Error eliminando documento:', error);
        res.status(500).json({
            success: false,
            message: 'Error eliminando documento: ' + error.message
        });
    }
});

// Eliminar todos los documentos
app.delete('/api/documents', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Contar documentos antes de eliminar
        const countResult = await client.query('SELECT COUNT(*) as total FROM documents');
        const totalDeleted = parseInt(countResult.rows[0].total);
        
        // Eliminar todos los documentos
        await client.query('DELETE FROM documents');
        
        // Reiniciar todos los contadores
        await client.query('UPDATE counters SET counter = 0');
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: `✅ Se eliminaron ${totalDeleted} documentos y se reiniciaron todos los contadores`
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error eliminando documentos:', error);
        res.status(500).json({
            success: false,
            message: 'Error eliminando documentos: ' + error.message
        });
    } finally {
        client.release();
    }
});

// Reiniciar contadores
app.post('/api/reset-counters', async (req, res) => {
    try {
        const { department, type } = req.body;
        
        if (!department && !type) {
            // Reiniciar todos los contadores
            await pool.query('UPDATE counters SET counter = 0');
            res.json({
                success: true,
                message: 'Todos los contadores han sido reiniciados a 0'
            });
        } else if (department && type) {
            // Reiniciar contador específico
            const year = new Date().getFullYear();
            await pool.query(
                'UPDATE counters SET counter = 0 WHERE department = $1 AND document_type = $2 AND year = $3',
                [department, type, year]
            );
            res.json({
                success: true,
                message: `Contador para ${department} - ${type} reiniciado`
            });
        } else {
            res.status(400).json({
                success: false,
                message: 'Para reiniciar un contador específico, proporcione tanto departamento como tipo'
            });
        }
    } catch (error) {
        console.error('❌ Error reiniciando contadores:', error);
        res.status(500).json({
            success: false,
            message: 'Error reiniciando contadores: ' + error.message
        });
    }
});

// Ruta de salud para verificar que el servidor funciona
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'Servidor SINTEL funcionando correctamente',
        database: 'Supabase conectado'
    });
});

// Iniciar servidor
app.listen(port, () => {
    console.log(`🚀 Servidor SINTEL iniciado en puerto ${port}`);
    console.log(`🌐 URL: http://localhost:${port}`);
    console.log(`📊 Base de datos: Supabase PostgreSQL`);
});

// Manejo de errores no capturados
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception thrown:', error);
    process.exit(1);
});
