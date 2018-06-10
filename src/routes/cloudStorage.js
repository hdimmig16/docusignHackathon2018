const express = require('express');
const Storage = require('@google-cloud/storage');
const Multer = require('multer');

const router = express.Router();

const projectId = process.env.GOOGLE_PROJECT_ID;
const bucketName = 'docusign-photos';

function getFullURL(bucket, filename) {
  return `https://storage.googleapis.com/${bucket}/${filename}`;
}

// Creates a client
const storage = new Storage({
  keyFilename: './googleCreds.json',
  projectId: projectId,
});
//Cache-Control:no-cache, max-age=0
// A bucket is a container for objects (files).
const bucket = storage.bucket(bucketName);

// Multer is required to process file uploads and make them available via
// req.files.
const multer = Multer({
  storage: Multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // no larger than 5mb, you can change as needed.
  }
});

// Process the file upload and upload to Google Cloud Storage.
router.post('/uploadPhoto', multer.single('file'), (req, res, next) => {
  if (!req.file) {
    res.status(400).send("No file uploaded.");
    return;
  }

  const blob = bucket.file(req.file.originalname);
  const blobStream = blob.createWriteStream({
    metadata: {
      contentType: req.file.mimetype,
    },
  });

  blobStream.on('error', (err) => {
    next(err);
    return;
  });

  blobStream.on("finish", () => {
    const publicUrl = getFullURL(bucket.name, blob.name);

    // Make the image public to the web for Kairos
    blob.makePublic().then(() => {
      const responseBody = {
        url: publicUrl
      }
      res.status(200).send(responseBody);
    });
  });

  blobStream.end(req.file.buffer);
});

module.exports = router;