const express = require('express');
const Datastore = require('@google-cloud/datastore');


const router = express.Router();

const projectId = "docusignhackathon-206716";
//const projectId = process.env.GOOGLE_PROJECT_ID;

// Creates a client
const datastore = new Datastore({
  keyFilename: './googleDatastoreCreds.json',
  projectId: projectId,
});

// A bucket is a container for objects (files).


router.post('/sessions', (req, res, next) => {
  const sessionName = req.body.sessionName;
  datastore.save({
    key: {kind: 'sessions'}, // defined above (datastore.key(['Company', 'Google']))
    data: {
      session_name: sessionName,
    }
  }, (err, entity) => {
    if (!err) {
      res.send(entity);
      return;
    }
    console.log(err);
    res.status(500).send(err);
  });
});

// Process the file upload and upload to Google Cloud Storage.
router.get('/sessions', (req, res, next) => {
  const query = datastore.createQuery('sessions');
  datastore.runQuery(query)
    .then(result => {
      const response = {
        data: result[0],
        cursor: result[1]
      }
      res.send(response);
    })
    .catch(error => {
      console.log(error)
      res.status(500).send(error);
    });
});

module.exports = router;