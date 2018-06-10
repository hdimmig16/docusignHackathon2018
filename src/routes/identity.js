const express = require('express');
const axios = require('axios');

const router = express.Router();

const API_ID = process.env.KAIROS_API_ID;
const API_KEY = process.env.KAIROS_API_KEY;

const headers = {
	"Content-Type": "application/json",
	"app_id": API_ID,
	"app_key": API_KEY
};

const KAIROS_GALLERY_ID = 'docusign-hackathon';

const client = axios.create({
  baseURL: 'https://api.kairos.com',
  timeout: 10000,
  headers: headers
});

router.route('/verifyImage')
  .post(async (req, res) => {
    const URL = req.body.url;
    const subjectId = req.body.subjectId;
    const requestBody = {
      image: URL,
      subject_id: subjectId,
      gallery_name: KAIROS_GALLERY_ID,
    };

    client.post('/verify', requestBody)
      .then((response) => {
        console.log(response);
        res.send(response.data);
      })
      .catch((e) => {
        console.log(e);
        res.status(500).send(e);
      });
  });

router.route('/addImage')
  .post(async (req, res) => {
    const URL = req.body.url;
    const subjectId = req.body.subjectId;
    const requestBody = {
      image: URL,
      subject_id: subjectId,
      gallery_name: KAIROS_GALLERY_ID,
    };

    client.post('/enroll', requestBody)
      .then((response) => {
        console.log(response);
        res.send(response.data);
      })
      .catch((e) => {
        console.log(e);
        res.status(500).send(e);
      });
  });

module.exports = router;
