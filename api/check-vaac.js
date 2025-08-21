// File: api/check-vaac.js (di proyek Vercel idwm-vaa-proxy)

const ftp = require('basic-ftp');
const { Writable } = require('stream');

function getTimestampFromAnyFilename(filename) {
    const match = filename.match(/\.(\d{12})\./);
    return match ? match[1] : null;
}

module.exports = async (req, res) => {
    // ================== BLOK KODE PERBAIKAN CORS (PENTING!) ==================
    // Memberikan izin kepada SEMUA domain ('*') untuk mengakses API ini.
    // Ini aman untuk API publik.
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Memberitahu browser metode apa saja yang diizinkan.
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    
    // Memberitahu browser header apa saja yang boleh ada dalam permintaan.
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Browser terkadang mengirim "preflight request" dengan metode OPTIONS
    // untuk memeriksa izin CORS sebelum mengirim permintaan GET yang sebenarnya.
    // Kita harus menanggapinya dengan status OK.
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    // ========================= AKHIR BLOK PERBAIKAN CORS =========================


    // Atur cache untuk menghemat kuota Vercel Anda.
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

        // --- SISA KODE ANDA DI BAWAH INI SAMA PERSIS DAN SUDAH BENAR ---

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

        const isIndonesiaArea = /^AREA:\s*INDONESIA/im.test(fullText);

        if (!isIndonesiaArea) {
            return res.status(200).json({
                advisoryNumber: null,
                message: "Latest VAA is not for Indonesia area.",
                fullText: fullText,
                imageBase64: null
            });
        }
        
        const advisoryMatch = fullText.match(/ADVISORY\s+NR:\s*(\d{4}\/\d+)/i);
        const advisoryNumber = advisoryMatch ? advisoryMatch[1] : null;
        
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

        res.status(200).json({
          advisoryNumber: advisoryNumber,
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
