const express = require('express');
const passport = require('passport');
const session = require('express-session');
const docusign = require('docusign-esign');
const moment = require('moment');
const fs = require('fs-extra');
const path = require('path');
const {promisify} = require('util'); // http://2ality.com/2017/05/util-promisify.html


const router = express.Router();
const port = process.env.APP_PORT || 3000
const host = process.env.APP_HOST || 'localhost'
const hostUrl = 'https://' + host + ':' + port
const clientID = process.env.DS_CLIENT_ID || '4e6848d3-3664-4678-89ab-d9984b5b1a45';
const clientSecret = process.env.DS_CLIENT_SECRET;
const signerEmail = process.env.DS_SIGNER_EMAIL || 'borrower3@certainfinancing.com';
const signerName = process.env.DS_SIGNER_NAME || 'Roger'
const templateId = process.env.DS_TEMPLATE_ID || 'a17dacfb-4458-4eac-a347-fee23b6d70bb';
const baseUriSuffix = '/restapi'
const testDocumentPath = '../../template.pdf'
const test2DocumentPath = '../demo_documents/battle_plan.docx';

let apiClient // The DocuSign API object
  , accountId // The DocuSign account that will be used
  , baseUri // the DocuSign platform base uri for the account.
  , eg // The example that's been requested
  ;

// Configure Passport
passport.use(new docusign.OAuthClient({
    sandbox: true,
    clientID: clientID,
    clientSecret: clientSecret,
    callbackURL: hostUrl + '/auth/callback',
    state: true // automatic CSRF protection.
    // See https://github.com/jaredhanson/passport-oauth2/blob/master/lib/state/session.js
  },
  function (accessToken, refreshToken, params, user, done) {
    // The params arg will be passed additional parameters of the grant.
    // See https://github.com/jaredhanson/passport-oauth2/pull/84
    //
    // Here we're just assigning the tokens to the user profile object but we
    // could be using session storage or any other form of transient-ish storage
    user.accessToken = accessToken;
    user.refreshToken = refreshToken;
    user.expiresIn = params.expires_in;
    // Calculate the time that the token will expire
    user.expires = moment().add(user.expiresIn, 's');
    return done(null, user);
  }
));

// Passport session setup.
//   To support persistent login sessions, Passport needs to be able to
//   serialize users into and deserialize users out of the session.  Typically,
//   this will be as simple as storing the user ID when serializing, and finding
//   the user by ID when deserializing.  However, since this example does not
//   have a database of user records, the complete GitHub profile is serialized
//   and deserialized.
passport.serializeUser(function(user, done) {done(null, user)});
passport.deserializeUser(function(obj, done) {done(null, obj)});

// Configure the webserver
router.use(session({
  secret: 'secret token',
  resave: true,
  saveUninitialized: true
}))
.use(passport.initialize())
.use(passport.session())
/* Home page */

// .get('/docusign', function (req, res) {
//   res.send(`<h2>Home page</h2>
// <h3><a href="/go?eg=1">Send Envelope via email</a></h3>
// <h3><a href="/go?eg=2">Embeddded Signing Ceremony</a></h3>
// <h3><a href="/go?eg=3">Send envelope using a template</a></h3>
// <h3><a href="/go?eg=4">Embedded Sending</a></h3>
// <h3><a href="/go?eg=5">Embedded DocuSign console</a></h3>
// <h3><a href="/go?eg=6">List multiple envelopes' status</a></h3>
// <h3><a href="/go?eg=7">Get an envelope's status</a></h3>
// <h3><a href="/go?eg=8">List an envelope's recipients</a></h3>
// <h3><a href="/go?eg=9">Download an envelope's document(s)</a></h3>
// `)})
/* Page for starting OAuth Authorization Code Grant */
.get('/auth', function (req, res, next) {
  passport.authenticate('docusign')(req, res, next);
})
/* Page for handling OAuth Authorization Code Grant callback */
.get('/auth/callback', [dsLoginCB1, dsLoginCB2])
/* Page to receive pings from the DocuSign embedded Signing Ceremony */
.get('/dsping', dsPingController)
/* Middleware: ensure that we have a DocuSign token. Obtain one if not. */
/*             checkToken will apply to all subsequent routes. */
.use(checkToken)
/* Page to execute an example */
.get('/docusign', goPageController)
.get('/go', goPageController)
//.get('/docusign', goPageController)
/**
 * Middleware: check that a token is available to be used.
 * If not, start the authorization process
 */
function checkToken(req, res, next) {
  if (req.query.eg){
    req.session.eg = req.query.eg; // Save the requested example number
  }
  // Do we have a token that can be used?
  // Use a 30 minute buffer time to enable the user to fill out
  // a request form and send it.
  let tokenBufferMin = 30
    , now = moment();
  if (tokenBufferMin && req.user && req.user.accessToken &&
       now.add(tokenBufferMin, 'm').isBefore(req.user.expires)) {
    console.log ('\nUsing existing access token.')
    next()
  } else {
    console.log ('\nGet a new access token.');
    res.redirect('/auth');
  }
}

/**
 * Page controller for processing the OAuth callback
 */
function dsLoginCB1 (req, res, next) {
  passport.authenticate('docusign', { failureRedirect: '/auth' })(req, res, next)
}
function dsLoginCB2 (req, res, next) {
  console.log(`Received access_token: ${req.user.accessToken.substring(0,15)}...`);
  console.log(`Expires at ${req.user.expires.format("dddd, MMMM Do YYYY, h:mm:ss a")}`);
  // If an example was not requested, redirect to home
  if (req.session.eg) {res.redirect('/go')
  }
  else if (req.query.event) {
    res.redirect('/success.html');
  } 
  else {
    res.redirect('/');
  }
}

/**
 * Page controller for executing an example.
 * Uses the session.eg saved parameter
 */
function goPageController (req, res, next) {
  console.log('received');
  // getting the API client ready
  apiClient = new docusign.ApiClient();
  apiClient.addDefaultHeader('Authorization', 'Bearer ' + req.user.accessToken);

  // The DocuSign Passport strategy looks up the user's account information via OAuth::userInfo.
  // See https://developers.docusign.com/esign-rest-api/guides/authentication/user-info-endpoints
  // We want the user's account_id, account_name, and base_uri
  // A user can (and often) belongs to multiple accounts.
  // You can search for a specific account the user has, or
  // give the user the choice of account to use, or use
  // the user's default account. This example used the default account.
  //
  // The baseUri changes rarely so it can (and should) be cached.
  //
  // req.user holds the result of DocuSign OAuth::userInfo and tokens.
  getDefaultAccountInfo(req.user.accounts)
  apiClient.setBasePath(baseUri); // baseUri is specific to the account
  docusign.Configuration.default.setDefaultApiClient(apiClient);
  // Execute an example.
  //eg = req.session.eg; // retrieve the requested example number
  eg = 2;
  req.session.eg = false; // reset

  Promise.resolve()
  // Send an envelope via email
  .then ((result) => eg == 1 ? createEnvelope(accountId) : result)
  // Embedded signing example (create Recipient View)
  .then ((result) => eg == 2 ? embeddedSigning(accountId) : result)
  // create a new envelope from template
  .then ((result) => eg == 3 ? createEnvelopeFromTemplate(accountId) : result)
  // Embedded sending example (create Sender View)
  .then ((result) => eg == 4 ? embeddedSending(accountId) : result)
  // Embedded DocuSign Console view (create Console view)
  .then ((result) => eg == 5 ? createConsoleView(accountId) : result)
  // get multiple envelope statuses (polling)
  .then ((result) => eg == 6 ? getMultipleEnvelopeStatuses(accountId) : result)
  // get an envelope's status (polling)
  .then ((result) => eg == 7 ? getEnvelopeStatus(accountId, req.session.sentEnvelopeId) : result)
  // list envelope recipients (polling)
  .then ((result) => eg == 8 ? listEnvelopeRecipients(accountId, req.session.sentEnvelopeId) : result)
  // download all envelope documents
  .then ((result) => eg == 9 ? downloadEnvelopeDocuments(accountId, req.session.sentEnvelopeId) : result)
  // handle the example's result
  .then ((result) => {
    let prefix = "<h2>Results:</h2><p>"
      , suffix = '</p><h2><a href="/">Continue</a></h2';
    // Save the envelopeId for later use:
    if (result.envelopeId) {req.session.sentEnvelopeId = result.envelopeId}
    if (result.redirect) {
      console.log(result);
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,PATCH,DELETE,OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With');
      console.log(result.redirect);
      res.redirect(result.redirect);
      //res.redirect(`https://cors-anywhere.herokuapp.com/${result.redirect.substring(8)}`);
    } else {
      res.send( `${prefix} ${result.msg} ${suffix}` );
    }
  })
}

/**
 * Page controller for processing the OAuth callback
 */
function dsPingController (req, res) {
  // This function is called periodically via AJAX from the
  // DocuSign Signing Ceremony. The AJAX calls include cookiers and
  // will keep our session fresh.
  // Any return values are ignored.
  console.log ('\nDocuSign PING received.');
  res.send()
}

/**
 * Set the variables accountId and baseUri from the default
 * account information.
 * @param {array} accounts Array of account information returned by
 *        OAuth::userInfo
 */
function getDefaultAccountInfo(accounts){
  let defaultAccount = accounts.find ((item) => item.is_default);
  console.log (`Default account "${defaultAccount.account_name}" (${defaultAccount.account_id})`);
  accountId = defaultAccount.account_id;
  baseUri =  `${defaultAccount.base_uri}${baseUriSuffix}`
}

/**
 * Return a promise version of an SDK method.
 * @param {object} obj a DocSign SDK object. Eg obj = new docusign.EnvelopesApi()
 * @param {string} method_name The string name of a method. Eg createEnvelope
 */
function make_promise(obj, method_name){
  let promise_name = method_name + '_promise';
  if (!(promise_name in obj)) {
    obj[promise_name] = promisify(obj[method_name]).bind(obj)
  }
  return obj[promise_name]
}


/////////////////////////////////////////////////////////////////////////////////

/**
 * Send an envelope (signing request) to one signer via email.
 * The file "test.pdf" will be used, with a Sign Here field
 * postioned via anchor text.
 * @param {string} accountId The accountId to be used.
 */
function createEnvelope(accountId) {
  // Create a byte array that will hold our document bytes
  let fileBytes, file2Bytes;
  try {
    // read document file
    fileBytes = fs.readFileSync(path.resolve(__dirname, testDocumentPath));
    file2Bytes = fs.readFileSync(path.resolve(__dirname, test2DocumentPath));
  } catch (ex) {
    // handle error
    console.log('Exception while reading file: ' + ex);
  }

  // Create an envelope that will store the document(s), field(s), and recipient(s)
  let envDef = new docusign.EnvelopeDefinition();
  envDef.emailSubject = 'Please sign this document sent from Node SDK';

  // Add a document to the envelope.
  // This code uses a generic constructor:
  let doc = new docusign.Document()
    , doc2 = new docusign.Document()
    , base64Doc = Buffer.from(fileBytes).toString('base64')
    , base64Doc2 = Buffer.from(file2Bytes).toString('base64');
  doc.documentBase64 = base64Doc;
  doc.name = 'Agreement 1.pdf'; // can be different from actual file name
  doc.fileExtension = 'pdf';
  doc.documentId = '1';
  doc2.documentBase64 = base64Doc2;
  doc2.name = 'Battle plan'; // can be different from actual file name
  doc2.fileExtension = 'docx';  // source document type. It will be converted to pdf
  doc2.documentId = '2';

  // Add to the envelope. Envelopes can have multiple docs, so an array is used
  envDef.documents = [doc, doc2];

  // Add a recipient to sign the document, identified by name and email
  // Objects for the SDK can be constructed from an object:
  let signer = docusign.Signer.constructFromObject(
    {email: signerEmail, name: signerName, recipientId: '1', routingOrder: '1'});

  // Both test documents include an "anchor string" of "/sn1/" in
  // white text. So we create Sign Here
  // fields in the documents, anchored at the string's location.
  // The offset is used to position the field correctly in the
  // document.
  let signHere = docusign.SignHere.constructFromObject({
    anchorString: '/sn1/',
    anchorYOffset: '10', anchorUnits: 'pixels',
    anchorXOffset: '20'});

  // A signer can have multiple tabs, so an array is used
  let signHereTabs = [signHere]
    , tabs = docusign.Tabs.constructFromObject({
              signHereTabs: signHereTabs});
  signer.tabs = tabs;

  // Add recipients (in this case a single signer) to the envelope
  envDef.recipients = new docusign.Recipients();
  envDef.recipients.signers = [signer];

  // Send the envelope by setting |status| to "sent". To save as a draft set to "created"
  envDef.status = 'sent';

  // instantiate a new EnvelopesApi object
  var envelopesApi = new docusign.EnvelopesApi();

  // call the createEnvelope() API to create and send the envelope
  // The createEnvelope() API is async and uses a callback
  // Promises are more convenient, so we promisfy it.
  let createEnvelope_promise = make_promise(envelopesApi, 'createEnvelope');
  return (
    createEnvelope_promise(accountId, {'envelopeDefinition': envDef})
    .then ((result) => {
      let msg = `\nCreated the envelope! Result: ${JSON.stringify(result)}`
      console.log(msg);
      return {msg: msg, envelopeId: result.envelopeId};
    })
    .catch ((err) => {
      // If the error is from DocuSign, the actual error body is available in err.response.body
      let errMsg = err.response && err.response.body && JSON.stringify(err.response.body)
        , msg = `\nException while creating the envelope! Result: ${err}`;
      if (errMsg) {
        msg += `. API error message: ${errMsg}`;
      }
      console.log(msg);
      return {msg: msg};
    })
  )
}

/////////////////////////////////////////////////////////////////////////////////

/**
 * Send an envelope (signing request) via email.
 * The envelope uses a template stored on the server.
 * The templateId must be set before this method can be used.
 * @param {string} accountId The accountId to be used.
 */
function createEnvelopeFromTemplate (accountId) {
  if (templateId === '{TEMPLATE_ID}') {
    let msg = `
PROBLEM: The templateId must be set before this example can be used.
<br>Set the templateId by modifying the source or using environment
variable <tt>DS_TEMPLATE_ID</tt>.
<p style="margin-top:1em">Creating the template:
<ol>
<li>See <a href="https://support.docusign.com/guides/ndse-user-guide-create-templates">Template instructions</a></li>
<li>For this example, the template must have a role named <tt>signer1</tt></li>
<li><a href="https://support.docusign.com/en/guides/ndse-user-guide-locate-template-id">Look up the template id</a>
and then either add it to this example's source or use the <tt>DS_TEMPLATE_ID</tt>
environment variable.</li>
<li>Restart the example's server and repeat the Envelope from a template example.</li>
</ol>
`
    return {msg: msg}
  }

  // create a new envelope object
  let envDef = new docusign.EnvelopeDefinition();
  envDef.emailSubject = 'Please sign this document sent from Node SDK';
  envDef.templateId = templateId;

  // create a template role object. It is used to assign data to a template's role.
  let tRole = docusign.TemplateRole.constructFromObject(
    {roleName: 'signer1', name: signerName, email: signerEmail});
  // create an array of template roles. In this case, there's just one
  envDef.templateRoles = [tRole];

  // send the envelope by setting |status| to 'sent'. To save as a draft set to 'created'
  envDef.status = 'sent';

  // instantiate a new EnvelopesApi object
  let envelopesApi = new docusign.EnvelopesApi();
  // The createEnvelope() API is async and uses a callback
  // Promises are more convenient, so we promisfy it.
  let createEnvelope_promise = make_promise(envelopesApi, 'createEnvelope');
  return (
    createEnvelope_promise(accountId, {'envelopeDefinition': envDef})
    .then ((result) => {
      let msg = `\nCreated the envelope! Result: ${JSON.stringify(result)}`
      console.log(msg);
      return {msg: msg};
    })
    .catch ((err) => {
      // If the error is from DocuSign, the actual error body is available in err.response.body
      let errMsg = err.response && err.response.body && JSON.stringify(err.response.body)
        , msg = `\nException while creating the envelope! Result: ${err}`;
      if (errMsg) {
        msg += `. API error message: ${errMsg}`;
      }
      console.log(msg);
      return {msg: msg};
    })
  )
}

/////////////////////////////////////////////////////////////////////////////////

/**
 * 1. Send an envelope (signing request) to one signer marked for
 * embedded signing (set the clientUserId parameter).
 * The file "test.pdf" will be used, with a Sign Here field
 * postioned via anchor text.
 * <br>
 * 2. Call getRecipientView and then redirect to the url
 * to initiate an embedded signing ceremony.
 * @param {string} accountId The accountId to be used.
 */
function embeddedSigning(accountId) {
  // Step 1, create the envelope is the same as for the createEnvelope
  // method except that the clientUserId parameter is set.
  // Create a byte array that will hold our document bytes
  let fileBytes;
  try {
    // read document file
    fileBytes = fs.readFileSync(path.resolve(__dirname, testDocumentPath));
  } catch (ex) {
    // handle error
    console.log('Exception while reading file: ' + ex);
  }

  // Create an envelope that will store the document(s), field(s), and recipient(s)
  let envDef = new docusign.EnvelopeDefinition();
  envDef.emailSubject = 'Please sign this document sent from Node SDK';

  // Add a document to the envelope.
  // This code uses a generic constructor:
  let doc = new docusign.Document()
    , base64Doc = Buffer.from(fileBytes).toString('base64');
  doc.documentBase64 = base64Doc;
  doc.name = 'TestFile.pdf'; // can be different from actual file name
  doc.extension = 'pdf';
  doc.documentId = '1';
  // Add to the envelope. Envelopes can have multiple docs, so an array is used
  envDef.documents = [doc];

  // Add a recipient to sign the document, identified by name and email
  // Objects for the SDK can be constructed from an object:
  let signer = docusign.Signer.constructFromObject(
    {email: signerEmail, name: signerName, recipientId: '1', routingOrder: '1', returnUrlRequest: `${host}/success.html`});

  //*** important: must set the clientUserId property to embed the recipient!
  // Otherwise the DocuSign platform will treat recipient as remote (an email
  // will be sent) and the embedded signing will not work.
  let clientUserId = '1001'
  signer.clientUserId = clientUserId;

  // The test.pdf document includes an "anchor string" of "/sn1/" in
  // white text in the document. So we create a Sign Here
  // field in the document anchored at the string's location.
  // The offset is used to position the field correctly in the
  // document.
  let signHere = docusign.SignHere.constructFromObject({
    anchorString: '/sn1/',
    anchorYOffset: '10', anchorUnits: 'pixels',
    anchorXOffset: '20'})

  // A signer can have multiple tabs, so an array is used
  let signHereTabs = [signHere]
    , tabs = docusign.Tabs.constructFromObject({
              signHereTabs: signHereTabs});
  signer.tabs = tabs;

  // Add recipients (in this case a single signer) to the envelope
  envDef.recipients = new docusign.Recipients();
  envDef.recipients.signers = [signer];

  // Send the envelope by setting |status| to "sent". To save as a draft set to "created"
  envDef.status = 'sent';

  // instantiate a new EnvelopesApi object
  var envelopesApi = new docusign.EnvelopesApi();

  // call the createEnvelope() API to create and send the envelope
  // The createEnvelope() API is async and uses a callback
  // Promises are more convenient, so we promisfy it.
  let createEnvelope_promise = make_promise(envelopesApi, 'createEnvelope');
  return (
    createEnvelope_promise(accountId, {'envelopeDefinition': envDef})
    .then ((result) => {
      let msg = `\nCreated the envelope! Result: ${JSON.stringify(result)}`
      console.log(msg);
      return result.envelopeId;
    })
    .then ((envelopeId) =>
      // Step 2 call createRecipientView() to generate the signing URL
      createRecipientView(accountId, envelopeId, clientUserId)
    )
    .catch ((err) => {
      // If the error is from DocuSign, the actual error body is available in err.response.body
      let errMsg = err.response && err.response.body && JSON.stringify(err.response.body)
        , msg = `\nException! Result: ${err}`;
      if (errMsg) {
        msg += `. API error message: ${errMsg}`;
      }
      console.log(msg);
      return {msg: msg};
    })
  )
}

/**
 * Step 2. Call getRecipientView and then redirect to the url
 * to initiate an embedded signing ceremony.
 * @param {string} accountId The accountId to be used.
 * @param {string} envelopeId The envelope's id.
 * @param {string} clientUserId The value used when the signer was added to the envelope.
 */
function createRecipientView(accountId, envelopeId, clientUserId) {
  // instantiate a new EnvelopesApi object
  let envelopesApi = new docusign.EnvelopesApi();
  let viewRequest = new docusign.RecipientViewRequest();

  // set the url where you want the recipient to go once they are done signing
  // should typically be a callback route somewhere in your app
  viewRequest.returnUrl = `${hostUrl}/success.html`;
  // How has your app authenticated the user? In addition to your app's
  // authentication, you can include authenticate steps from DocuSign.
  // Eg, SMS authentication
  viewRequest.authenticationMethod = 'none';
  // recipient information must match embedded recipient info
  // we used to create the envelope.
  viewRequest.email = signerEmail;
  viewRequest.userName = signerName;
  viewRequest.clientUserId = clientUserId;

  // DocuSign recommends that you redirect to DocuSign for the
  // Signing Ceremony. There are multiple ways to save state.
  // To maintain your application's session, use the pingUrl
  // parameter. It causes the DocuSign Signing Ceremony web page
  // (not the DocuSign server) to send pings via AJAX to your
  // app,
  viewRequest.pingFrequency = 600; // seconds
  // NOTE: The pings will only be sent if the pingUrl is an https address
  viewRequest.pingUrl = `${hostUrl}/dsping`;

  // call the CreateRecipientView API
  let createRecipientView_promise = make_promise(envelopesApi, 'createRecipientView');
  return (
    createRecipientView_promise(accountId, envelopeId,
      {recipientViewRequest: viewRequest})
    .then ((result) => {
      let msg = `\nCreated the recipientView! Result: ${JSON.stringify(result)}`
      console.log(msg);
      return {redirect: result.url};
    })
  )
}

/////////////////////////////////////////////////////////////////////////////////

/**
 * 1. Create a draft envelope (signing request) for one signer.
 * The file "test.pdf" will be used, with a Sign Here field
 * absolutely positioned
 * <br>
 * 2. Call getSenderView and then redirect to the url
 * to initiate an embedded sending ceremony.
 * @param {string} accountId The accountId to be used.
 */
function embeddedSending(accountId) {
  // Create a byte array that will hold our document bytes
  let fileBytes;
  try {
    // read document file
    fileBytes = fs.readFileSync(path.resolve(__dirname, testDocumentPath));
  } catch (ex) {
    // handle error
    console.log('Exception while reading file: ' + ex);
  }

  // Create an envelope that will store the document(s), field(s), and recipient(s)
  let envDef = new docusign.EnvelopeDefinition();
  envDef.emailSubject = 'Please sign this document sent from Node SDK';

  // Add a document to the envelope.
  // This code uses a generic constructor:
  let doc = new docusign.Document()
    , base64Doc = Buffer.from(fileBytes).toString('base64');
  doc.documentBase64 = base64Doc;
  doc.name = 'TestFile.pdf'; // can be different from actual file name
  doc.extension = 'pdf';
  doc.documentId = '1';
  // Add to the envelope. Envelopes can have multiple docs, so an array is used
  envDef.documents = [doc];

  // Add a recipient to sign the document, identified by name and email
  // Objects for the SDK can be constructed from an object:
  let signer = docusign.Signer.constructFromObject(
    {email: signerEmail, name: signerName, recipientId: '1', routingOrder: '1'});

  // create a signHere tab 100 pixels down and 150 right from the top left
  // corner of first page of document
  let signHere = new docusign.SignHere();
  signHere.documentId = '1';
  signHere.pageNumber = '1';
  signHere.recipientId = '1';
  signHere.xPosition = '100';
  signHere.yPosition = '150';

  // A signer can have multiple tabs, so an array is used
  let signHereTabs = [signHere]
    , tabs = docusign.Tabs.constructFromObject({
              signHereTabs: signHereTabs});
  signer.tabs = tabs;

  // Add recipients (in this case a single signer) to the envelope
  envDef.recipients = new docusign.Recipients();
  envDef.recipients.signers = [signer];

  // Create a draft envelope by setting |status| to "created"
  envDef.status = 'created';

  // instantiate a new EnvelopesApi object
  let envelopesApi = new docusign.EnvelopesApi();

  // call the createEnvelope() API to create and send the envelope
  // The createEnvelope() API is async and uses a callback
  // Promises are more convenient, so we promisfy it.
  let createEnvelope_promise = make_promise(envelopesApi, 'createEnvelope');
  return (
    createEnvelope_promise(accountId, {'envelopeDefinition': envDef})
    .then ((result) => {
      let msg = `\nCreated the draft envelope! Result: ${JSON.stringify(result)}`
      console.log(msg);
      return result.envelopeId;
    })
    .then ((envelopeId) =>
      // Step 2 call createSenderView() to generate the signing URL!
      createSenderView(accountId, envelopeId)
    )
    .catch ((err) => {
      // If the error is from DocuSign, the actual error body is available in err.response.body
      let errMsg = err.response && err.response.body && JSON.stringify(err.response.body)
        , msg = `\nException! Result: ${err}`;
      if (errMsg) {
        msg += `. API error message: ${errMsg}`;
      }
      console.log(msg);
      return {msg: msg};
    })
  )
}

/////////////////////////////////////////////////////////////////////////////////

/**
 * Step 2. Call getSenderView and then redirect to the url
 * to initiate an embedded sending for the envelope.
 * The sender's view can be started either in the
 * sender (recipients and documents) screen or the tagging
 * screen of the sender web tool.
 * @param {string} accountId The accountId to be used.
 * @param {string} envelopeId The envelope's id.
 */
function createSenderView(accountId, envelopeId) {
  let startWithRecipientsScreen = true;

  // instantiate a new EnvelopesApi object
  let envelopesApi = new docusign.EnvelopesApi();

  // set the url where you want the recipient to go once they are done signing
  // should typically be a callback route somewhere in your app
  let viewRequest = new docusign.ReturnUrlRequest();
  viewRequest.returnUrl = hostUrl;

  // call the CreateRecipientView API
  let createSenderView_promise = make_promise(envelopesApi, 'createSenderView');
  return (
    createSenderView_promise(accountId, envelopeId, {returnUrlRequest: viewRequest})
    .then ((result) => {
      let msg = `\nCreated the senderView! Result: ${JSON.stringify(result)}
Start with the recipient's screen: ${startWithRecipientsScreen}`
      console.log(msg);
      let url = result.url;
      if (startWithRecipientsScreen) {
        url = url.replace('send=1', 'send=0');
      }
      return {redirect: url};
    })
  )
}

/////////////////////////////////////////////////////////////////////////////////

/**
 * Open the console view of NDSE for the user.
 * @param {string} accountId The accountId to be used.
 */
function createConsoleView(accountId) {
  // instantiate a new EnvelopesApi and consoleViewRequest objects
  let envelopesApi = new docusign.EnvelopesApi()
    , viewRequest = new docusign.ConsoleViewRequest();
  viewRequest.returnUrl = hostUrl;

  // call the CreateConsoleView API
  let createConsoleView_promise = make_promise(envelopesApi, 'createConsoleView');
  return (
    createConsoleView_promise(accountId, {'consoleViewRequest': viewRequest})
    .then ((result) => {
      let msg = `\nCreated the ConsoleView! Result: ${JSON.stringify(result)}`
      console.log(msg);
      return {redirect: result.url};
    })
    .catch ((err) => {
      // If the error is from DocuSign, the actual error body is available in err.response.body
      let errMsg = err.response && err.response.body && JSON.stringify(err.response.body)
        , msg = `\nException! Result: ${err}`;
      if (errMsg) {
        msg += `. API error message: ${errMsg}`;
      }
      console.log(msg);
      return {msg: msg};
    })
  )
}

/////////////////////////////////////////////////////////////////////////////////

/**
 * List envelopes in the account
 * @param {string} accountId The accountId to be used.
 */
function getMultipleEnvelopeStatuses(accountId) {
  // The Envelopes::listStatusChanges method has many options
  // See https://developers.docusign.com/esign-rest-api/reference/Envelopes/Envelopes/listStatusChanges

  // The list status changes call requires at least a from_date OR
  // a set of envelopeIds. Here we filter using a from_date.
  // Here we set the from_date to filter envelopes for the last month
  // Use ISO 8601 date format
  let options = {fromDate: moment().subtract(30, 'days').format()};

  // instantiate a new EnvelopesApi object
  let envelopesApi = new docusign.EnvelopesApi();
  // The createEnvelope() API is async and uses a callback
  // Promises are more convenient, so we promisfy it.
  let listStatusChanges_promise = make_promise(envelopesApi, 'listStatusChanges');
  return (
    listStatusChanges_promise(accountId, options)
    .then ((result) => {
      console.log(`\nEnvelope list result received!`);
      let h = `Envelope list result:</p><p><pre><code>${JSON.stringify(result, null, '    ')}</code></pre>`
      // Save an envelopeId for later use if an envelope list was returned (result set could be empty)
      let envelopeId = result.envelopes && result.envelopes[0] && result.envelopes[0].envelopeId,
          returnMsg = {msg: h};
      if (envelopeId) {returnMsg.envelopeId = envelopeId}
      return returnMsg
    })
    .catch ((err) => {
      // If the error is from DocuSign, the actual error body is available in err.response.body
      let errMsg = err.response && err.response.body && JSON.stringify(err.response.body)
        , msg = `\nException! Result: ${err}`;
      if (errMsg) {
        msg += `. API error message: ${errMsg}`;
      }
      console.log(msg);
      return {msg: msg};
    })
  )
}

/////////////////////////////////////////////////////////////////////////////////

/**
 * Get an envelope's current status
 * @param {string} accountId The accountId to be used.
 * @param {string} envelopeId The envelope to be looked up.
 */
function getEnvelopeStatus(accountId, envelopeId) {
  if (!envelopeId){
    let msg = `
PROBLEM: This example software doesn't know which envelope's information should be looked up. <br>
SOLUTION: First run the <b>Send Envelope via email</b> example to create an envelope.`
    return {msg: msg}
  }

  // call the getEnvelope() API
  let envelopesApi = new docusign.EnvelopesApi();
  let getEnvelope_promise = make_promise(envelopesApi, 'getEnvelope');
  return (
    getEnvelope_promise(accountId, envelopeId, null)
    .then ((result) => {
      console.log(`\nGet Envelope result received!`);
      let h = `Get Envelope result:</p><p><pre><code>${JSON.stringify(result, null, '    ')}</code></pre>`
      return {msg: h}
    })
    .catch ((err) => {
      // If the error is from DocuSign, the actual error body is available in err.response.body
      let errMsg = err.response && err.response.body && JSON.stringify(err.response.body)
        , msg = `\nException! Result: ${err}`;
      if (errMsg) {
        msg += `. API error message: ${errMsg}`;
      }
      console.log(msg);
      return {msg: msg};
    })
  )
}

/////////////////////////////////////////////////////////////////////////////////

/**
 * Get an envelope's current recipient status
 * @param {string} accountId The accountId to be used.
 * @param {string} envelopeId The envelope to be looked up.
 */
function listEnvelopeRecipients(accountId, envelopeId) {
  if (!envelopeId){
    let msg = `
PROBLEM: This example software doesn't know which envelope's information should be looked up. <br>
SOLUTION: First run the <b>Send Envelope via email</b> example to create an envelope.`
    return {msg: msg}
  }

  // call the listRecipients() API
  let envelopesApi = new docusign.EnvelopesApi();
  let listRecipients_promise = make_promise(envelopesApi, 'listRecipients');
  return (
    listRecipients_promise(accountId, envelopeId, null)
    .then ((result) => {
      console.log(`\nList envelope recipients result received!`);
      let h = `List envelope recipients result:</p><p><pre><code>${JSON.stringify(result, null, '    ')}</code></pre>`
      return {msg: h}
    })
    .catch ((err) => {
      // If the error is from DocuSign, the actual error body is available in err.response.body
      let errMsg = err.response && err.response.body && JSON.stringify(err.response.body)
        , msg = `\nException! Result: ${err}`;
      if (errMsg) {
        msg += `. API error message: ${errMsg}`;
      }
      console.log(msg);
      return {msg: msg};
    })
  )
}

/////////////////////////////////////////////////////////////////////////////////

/**
 * List, then download the envelopes documents to ./downloaded_documents folder
 * @param {string} accountId The accountId to be used.
 * @param {string} envelopeId The envelope to be looked up.
 */
function downloadEnvelopeDocuments(accountId, envelopeId) {
  if (!envelopeId){
    let msg = `
PROBLEM: This example software doesn't know which envelope's information should be looked up. <br>
SOLUTION: First run the <b>Send Envelope via email</b> example to create an envelope.`
    return {msg: msg}
  }

  //The workflow will be multiple API requests:
  // 1) list the envelope's documents
  // 2) Loop to get each document
  const docDownloadDir = "downloaded_documents"
      , docDownloadDirPath = path.resolve(__dirname, docDownloadDir);
  let completeMsg = `Documents downloaded to ${docDownloadDirPath}`;

  return ( // return a promise
    // Create the dir
    fs.ensureDir(docDownloadDirPath)
    .catch (err => {;})
    .then (() => {
      let envelopesApi = new docusign.EnvelopesApi();
      // call the listDocuments() API
      let listDocuments_promise = make_promise(envelopesApi, 'listDocuments');
      return listDocuments_promise(accountId, envelopeId, null)
    })
    .then ((result) => {
      console.log(`\nList documents response received!\n${JSON.stringify(result, null, '    ')}`);
      return result
    })
    .catch ((err) => {
      // If the error is from DocuSign, the actual error body is available in err.response.body
      let errMsg = err.response && err.response.body && JSON.stringify(err.response.body)
        , msg = `\nException! Result: ${err}`;
      if (errMsg) {
        msg += `. API error message: ${errMsg}`;
      }
      console.log(msg);
      return {msg: msg};
    })
    .then ((result) => {
      // Create a promise chain for each document in the results list.
      // Use the envelopeId in the file name.
      // Documents of type summary and content will be of type pdf.
      // Other types will also be pdf except for telephone authentication
      // voice files and perhaps other file types in the future.
      let envelopesApi = new docusign.EnvelopesApi()
        , getDocument_promise = make_promise(envelopesApi, 'getDocument');

      function getDocument(doc){
        let docName = `${envelopeId}__${doc.name}`
          , hasPDFsuffix = docName.substr(docName.length - 4).toUpperCase() === '.PDF'
          ;
        // Add .pdf if it's a content or summary doc and doesn't already end in .pdf
        if ((doc.type === "content" || doc.type === "summary") && !hasPDFsuffix){
          docName += ".pdf"
        }
        return (
          getDocument_promise(accountId, envelopeId, doc.documentId, null)
          .then ((docBytes) =>
            fs.writeFile(path.resolve(docDownloadDirPath, docName), docBytes, {encoding: 'binary'}))
          .then (() => {
            completeMsg += `<br>\nWrote document id ${doc.documentId} to ${docName}`
          })
          .catch ((err) => {
            // If the error is from DocuSign, the actual error body is available in err.response.body
            let errMsg = err.response && err.response.body && JSON.stringify(err.response.body)
              , msg = `\nException while processing document ${doc.documentId} Result: ${err}`;
            if (errMsg) {
              msg += `. API error message: ${errMsg}`;
            }
            console.log(msg);
            return Promise.resolve()
          })
        )
      }

      // Return the promise chain from last element
      return (
        result.envelopeDocuments.reduce(function (chain, item) {
          // bind item to first argument of function handle, replace `null` context as necessary
          return chain.then(getDocument.bind(null, item));
          // start chain with promise of first item
        }, Promise.resolve())
        .then (() => {
          console.log(completeMsg);
          return {msg: completeMsg}
        })
      )
    })
  )
}

module.exports = router;