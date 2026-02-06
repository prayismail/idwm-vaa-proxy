// File: api/check-vaac.js (di proyek Vercel idwm-vaa-proxy)

const ftp = require('basic-ftp');
const { Writable } = require('stream');
const crypto = require('crypto'); // --- BARU: Impor modul kriptografi

function getTimestampFromAnyFilename(filename) {
    const match = filename.match(/\.(\d{12})\./);
    return match ? match[1] : null;
}

module.exports = async (req, res) => {
    // ================== BLOK KODE PERBAIKAN CORS (PENTING!) ==================
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    // ========================= AKHIR BLOK PERBAIKAN CORS =========================

    // Atur cache
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

    if (req.method !== 'GET') {
        return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    }

    const client = new ftp.Client(30000);

    try {
        await client.access({ host: "ftp.bom.gov.au" });
        const currentYear = new Date().getFullYear();
        const directoryPath = `/anon/gen/vaac/${currentYear}`;
        await client.cd(directoryPath);
        const list = await client.list();

        const darwinTxtFiles = list.filter(item => item.name.startsWith('IDY') && item.name.endsWith('.txt') && item.type === ftp.FileType.File);
        if (darwinTxtFiles.length === 0) {
            return res.status(404).json({ error: `Tidak ada file .txt ditemukan.` });
        }
        
        let latestFile = null;
        let latestTimestamp = '0';
        darwinTxtFiles.forEach(file => {
            const timestamp = getTimestampFromAnyFilename(file.name);
            if (timestamp && timestamp > latestTimestamp) {
                latestTimestamp = timestamp;
                latestFile = file;
            }
        });

        if (!latestFile) {
            return res.status(404).json({ error: `Tidak ada file .txt valid.` });
        }
        
        const txtWritable = new Writable();
        const txtChunks = [];
        txtWritable._write = (chunk, encoding, next) => { txtChunks.push(chunk); next(); };
        await client.downloadTo(txtWritable, latestFile.name);
        const fullText = Buffer.concat(txtChunks).toString('utf-8');

        // --- BARU: Buat hash unik (sidik jari) dari seluruh konten teks VAA ---
        const advisoryHash = crypto.createHash('sha1').update(fullText).digest('hex');

        const advisoryMatch = fullText.match(/ADVISORY\s+NR:\s*(\d{4}\/\d+)/i);
        const advisoryNumber = advisoryMatch ? advisoryMatch[1] : null;

        const isIndonesiaArea = /^AREA:\s*INDONESIA/im.test(fullText);

        if (!isIndonesiaArea) {
            // Tetap kirim hash agar frontend tahu status VAA terbaru di server
            return res.status(200).json({
                advisoryNumber: advisoryNumber,
                advisoryHash: advisoryHash, // <-- Kirim hash
                message: "Latest VAA is not for Indonesia area.",
                fullText: fullText,
                imageBase64: null
            });
        }
        
        let imageBase64 = null;
        const matchingPngFile = list.find(item => 
            item.name.endsWith('.png') && getTimestampFromAnyFilename(item.name) === latestTimestamp
        );
        
        if (matchingPngFile) {
            const pngWritable = new Writable();
            const pngChunks = [];
            pngWritable._write = (chunk, encoding, next) => { pngChunks.push(chunk); next(); };
            await client.downloadTo(pngWritable, matchingPngFile.name);
            const imageBuffer = Buffer.concat(pngChunks);
            imageBase64 = `data:image/png;base64,${imageBuffer.toString('base64')}`;
        }

        // --- MODIFIKASI: Tambahkan 'advisoryHash' ke respons JSON ---
        res.status(200).json({
          advisoryNumber: advisoryNumber,
          advisoryHash: advisoryHash, // <-- Hash unik ditambahkan di sini
          fullText: fullText,
          imageBase64: imageBase64,
        });

    } catch (error) {
        console.error('[Proxy VAAC-FTP-Vercel] Kesalahan internal:', error);
        res.status(500).json({ error: 'Kesalahan internal pada server proxy FTP.', details: error.message });
    } finally {
        if (!client.closed) client.close();
    }
};
