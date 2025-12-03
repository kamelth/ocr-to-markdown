/**
 * OCR-to-Markdown Express Server
 * Runs on EC2, provides web UI and OCR processing
 */

// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const multer = require('multer');
const Together = require('together-ai');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer for file uploads (store in memory)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Initialize S3 client
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1'
});

// Initialize Together AI client
const together = new Together({
    apiKey: process.env.TOGETHER_API_KEY
});

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public')); // Serve static files from public folder

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'OCR-to-Markdown',
        timestamp: new Date().toISOString()
    });
});

/**
 * OCR processing endpoint
 * Accepts image upload, processes with llama-ocr, saves to S3
 */
app.post('/api/ocr', upload.single('image'), async (req, res) => {
    console.log('📥 Received OCR request');

    try {
        // Validate request
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No image file provided. Please upload an image.'
            });
        }

        const apiKey = process.env.TOGETHER_API_KEY;
        if (!apiKey) {
            return res.status(500).json({
                success: false,
                error: 'Server configuration error: TOGETHER_API_KEY not set'
            });
        }

        const bucketName = process.env.BUCKET_NAME;
        if (!bucketName) {
            return res.status(500).json({
                success: false,
                error: 'Server configuration error: BUCKET_NAME not set'
            });
        }

        console.log('📷 Processing image:', req.file.originalname, `(${req.file.size} bytes)`);

        // Upload to S3
        const timestamp = Date.now();
        const s3Key = `uploads/${timestamp}-${req.file.originalname}`;
        await uploadToS3(bucketName, s3Key, req.file.buffer, req.file.mimetype);
        console.log('☁️  Uploaded to S3:', s3Key);

        // Convert image to base64
        const base64Image = req.file.buffer.toString('base64');
        const imageDataUrl = `data:${req.file.mimetype};base64,${base64Image}`;

        // Run OCR with Together AI Chat Completions API
        console.log('🤖 Running OCR with Together AI Vision...');
        const startTime = Date.now();

        const response = await together.chat.completions.create({
            model: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Extract all text from this image and format it as clean markdown. Include headings, lists, tables, and any structure visible in the image. Only return the markdown content, no explanations.'
                        },
                        {
                            type: 'image_url',
                            image_url: {
                                url: imageDataUrl
                            }
                        }
                    ]
                }
            ],
            max_tokens: 4096,
            temperature: 0.1
        });

        const markdown = response.choices[0]?.message?.content || 'No text extracted';
        const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`✅ OCR completed in ${processingTime}s, markdown length: ${markdown.length}`);

        // Save markdown to S3
        const mdKey = s3Key.replace(/\.[^.]+$/, '.md');
        await uploadToS3(bucketName, mdKey, markdown, 'text/markdown');
        console.log('📝 Saved markdown to S3:', mdKey);

        // Return result
        res.json({
            success: true,
            message: 'OCR processing completed successfully',
            data: {
                inputFile: s3Key,
                outputFile: mdKey,
                markdown: markdown,
                bucket: bucketName,
                processingTime: `${processingTime}s`
            }
        });

    } catch (error) {
        console.error('❌ Error processing OCR:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to process image'
        });
    }
});

/**
 * Upload file to S3
 */
async function uploadToS3(bucket, key, content, contentType) {
    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: content,
        ContentType: contentType
    });
    await s3Client.send(command);
}

/**
 * Start server
 */
app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('🚀 OCR-to-Markdown Server Started!');
    console.log('=====================================');
    console.log(`📍 Server running on port ${PORT}`);
    console.log(`🌐 Access at: http://localhost:${PORT}`);
    console.log(`🔧 Environment:`);
    console.log(`   - Region: ${process.env.AWS_REGION || 'us-east-1'}`);
    console.log(`   - S3 Bucket: ${process.env.BUCKET_NAME || 'NOT SET'}`);
    console.log(`   - Together API Key: ${process.env.TOGETHER_API_KEY ? 'SET ✓' : 'NOT SET ✗'}`);
    console.log('=====================================');
    console.log('');
});
