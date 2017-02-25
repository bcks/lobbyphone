var express     = require('express'),
    app         = express(),
    server      = require('http').createServer(app),
    winston     = require('winston'),
    each        = require('tiny-each-async'),
    request     = require('request'),
    OpenStates  = require('openstates'),
    plivo       = require('plivo'),
    config      = require('./config.js'),
    zips        = require('./zips.json'),
    port        = config.port;

const plivoOutbound = config.plivoOutbound;
const inboundPhone  = config.inboundPhone;


//
// Init APIs
//

var p = plivo.RestAPI({
  authId: config.plivoAuthId,
  authToken: config.plivoAuthToken
});

var openstates = new OpenStates(config.sunlightAPI);



//
// Set Up Logging
//

var logger = new (winston.Logger)({
  transports: [ new (winston.transports.Console)({ json: false, timestamp: true }) ],
  exceptionHandlers: [ new (winston.transports.Console)({ json: false, timestamp: true }) ],
  exitOnError: false
});



//
// Express configure
//

var bodyParser = require('body-parser')
app.use(bodyParser.urlencoded({ extended: false }))
server.listen(port, function () {
  logger.info('Server listening at port %d', port);
});

app.post('/sms', receiveSMS);




//
// Receive Text Message
// 

function receiveSMS(req, res) {
  var incoming = {
    'text': req.body.Text,
    'id': req.body.MessageUUID,
    'from': req.body.From,
    'debug': req.body.Debug,
  };
  res.sendStatus(200);
 
  logger.info('incomingSMS:',incoming);

  var testWords = ['','hi','hello','text','test','info','rep info','congressional representatives','state representatives'];
  var niceWords = ['nice','cool','neat','this is awesome','👍'];
  var thanksWords = ['thanks','thank you','awesome thanks','thx'];

  if ( niceWords.indexOf( incoming.text.toLowerCase().replace(/[.!]/g,"") ) > -1 ) {
    sendResponse( incoming.from, "Thanks!", null, incoming.debug );

  } else if ( thanksWords.indexOf( incoming.text.toLowerCase().replace(/[.!]/g,"") ) > -1 ) {
    sendResponse( incoming.from, "You're welcome!", null, incoming.debug );

  } else if ( (testWords.indexOf( incoming.text.toLowerCase().replace(/[.!]/g,"") ) > -1 ) || ( incoming.text.length < 4 ) ) {
    sendResponse( incoming.from, 'Hi! Text a US postal address to '+inboundPhone+' and I will send back phone numbers for your state and federal legislators.', null, incoming.debug );

  } else if ( incoming.text.match(/\d+/g) == null ) { // no numbers at all.
    sendResponse( incoming.from, 'I’m sorry, I only speak postal. Text a US postal address to '+inboundPhone+' and I will send back phone numbers for your state & federal legislators.', null, incoming.debug );

  } else {
    geocode( incoming.from, incoming.text, incoming.debug );
  }


} // end receiveSMS





//
// Geocode Postal Address
// 

function geocode( recipient, address, debug ) {
  
  logger.info('geocoder got address:',address);

  // first try local zip:

  if ( /^\d{5}$/.test(address) && zips.filter( function(zips){ return zips.zip == address } )[0] !== undefined ) {
    logger.info('local zip found.');
    var geo = zips.filter( function(zips){ return zips.zip == address } )[0].geo;
    getReps( recipient, geo, address, debug );

  } else {



  // then try geocode with Google:

  var url = 'https://maps.googleapis.com/maps/api/geocode/json?address='+address+'&key='+config.googleAPI;

  request(url, function (err, response, body) {
    if (err) {
      logger.info('Google maps error:', body);
      sendResponse( recipient, 'I’m sorry, I don’t understand that address. Try texting it a different way to '+inboundPhone+'.', null, debug );
    }
    data = JSON.parse(body);
    
    //logger.info('geocoder response:',data);

    if (data.results.length) {
    
        var address_components = JSON.stringify(data.results[0].address_components);

        if ( address_components.indexOf("United States") > -1)  {
          var geo = data.results[0].geometry.location;
          logger.info('geo:',geo);
          getReps( recipient, geo, address, debug );
        } else {
          logger.info('Not US. Google address components:',address_components);
          sendResponse( recipient, "I'm sorry, I can't find that address within the U.S.", null, debug);
        }

    } else {

      // if that didn't work, try geocode with MapQuest:

      logger.info('Google couldn\'t find it. Trying MapQuest.');

      url = 'http://open.mapquestapi.com/geocoding/v1/address?key='+config.mapquestAPI+'&location='+address;

      if ( /^\d+$/.test(address) || /^\d+\-\d+$/.test(address) ) {
        url = 'http://open.mapquestapi.com/geocoding/v1/address?key='+config.mapquestAPI+'&postalCode='+address+'&country=USA';
      }
      
      request(url, function (err, response, body) {
        if (err) {
          logger.info('MapQuest error:', body);
          sendResponse( recipient, 'I’m sorry, I don’t understand that address. Try texting it a different way to '+inboundPhone+'.', null, debug );
        }
        data = JSON.parse(body);

        if (typeof data.results !== 'undefined') {

          var address_components = JSON.stringify(data.results[0].locations[0]);

          if (address_components !== 'undefined') {
            if ( address_components.indexOf("US") > -1)  {
              var geo = data.results[0].locations[0].latLng;
              logger.info('geo:',geo);
              getReps( recipient, geo, address, debug );
            } else {
              logger.info('Not US. MapQuest address components:',address_components);
              sendResponse( recipient, "I'm sorry, I can't find that address within the U.S.", null, debug );
            } // end address_components.indexOf("US") > -1
          } else {
              logger.info('Not address_components:',address_components);
              sendResponse( recipient, 'I’m sorry, I don’t understand that address. Try texting it a different way to '+inboundPhone+'.', null, debug );
          } // end address_components !== 'undefined'

        } else {

          logger.info('MapQuest got no results.');
          sendResponse( recipient, "I'm sorry, I can't find that address.", null, debug );

        } // end typeof data.results !== 'undefined'
    
      }); // end mapquest request

    } // end no results from Google

  }); // end Google request

  } // end test local zip

}






//
// Get Representatives
// 

function getReps( recipient, geo, address, debug ) {

    var url = 'https://www.googleapis.com/civicinfo/v2/representatives?address='+geo.lat+'%2C'+geo.lng+'&levels=country&levels=administrativeArea1&roles=legislatorLowerBody&roles=legislatorUpperBody&fields=offices%2Cofficials(name%2Cparty%2Cphones)&key='+config.googleAPI;

    request(url, function (err, response, body) {
        
        body = JSON.parse(body);

        if ((err) || (typeof body.error !== 'undefined') || typeof body.officials == 'undefined') {        
          logger.info('getReps can\'t find reps for that address.');
          
          if ( /^\d+$/.test(address) || /^\d+\-\d+$/.test(address) ) {
            // try http://whoismyrepresentative.com/getall_mems.php?zip=47803
            sendResponse( recipient, 'I’m sorry, I can’t find representatives for that ZIP code. Sometimes ZIP code alone does not always work. Try texting a postal address to '+inboundPhone+'.', null, debug );
          } else {
            sendResponse( recipient, 'I’m sorry, I can’t find representatives for that address.', null, debug );          
          }

        } else {

          logger.info('Got reps.');
          //debug(body);
          
          var reps = [];
          var n = -1;
          var hasState = 0;

          each(body.officials, function ( thisRep, thisRepCallback ){
              var title, order = '';
              n++;
              
              if (thisRep.name == 'Vacant') {

                thisRepCallback();

              } else {
              
                each(body.offices, function ( thisOffice, thisOfficeCallback ){
              
                  if (typeof thisOffice.officialIndices !== 'undefined') {
                
                    if (thisOffice.officialIndices.indexOf(n) > -1 ) {                
                      if ((thisOffice.levels[0] == 'administrativeArea1') && (thisOffice.roles[0] == 'legislatorUpperBody')) {
                        title = 'State Sen.';
                        order = 2;
                        hasState = 1;
                      }
                      if ((thisOffice.levels[0] == 'administrativeArea1') && (thisOffice.roles[0] == 'legislatorLowerBody')) {
                        title = 'State Rep.';
                        order = 3;
                        hasState = 1;
                      }
                      if ((thisOffice.levels[0] == 'country') && (thisOffice.roles[0] == 'legislatorUpperBody')) {
                        title = 'Senator';
                        order = 0;
                      }
                      if ((thisOffice.levels[0] == 'country') && (thisOffice.roles[0] == 'legislatorLowerBody')) {
                        title = 'Representative';
                        order = 1;
                      }
                      thisOfficeCallback();
                    } else {
                      thisOfficeCallback();
                    }

                  } else {
                    thisOfficeCallback();
                  }

              }, function(err) {
                if (err) { logger.info("async thisOffice:",err); }

                if (typeof thisRep.phones !== 'undefined') {
                  // change phone format    
                  var phone = thisRep.phones[0];    
                  phone = phone.replace(/[()]/g, '').replace(/ /,'-'); 

                  var rep = {
                    "name": title + ' ' + thisRep.name,
                    "phone": phone,
                    "order": order };
                  reps.push(rep);
                  thisRepCallback();
                } else {
                  thisRepCallback();              
                }
              });
              
            } // if is seat vacant


          }, function(err) {
            if (err) { logger.info("async thisRep:",err); }

            if (hasState) {
              sendResponse( recipient, '', reps, debug);
            } else {
              getState( recipient, address, geo, reps, debug );
            }
          });

      } // end if error
    }); // end civicAPI request
}

 
 

//
// Get State Representatives
// 

function getState(recipient, address, geo, reps, debug) {

    logger.info('Google didn\'t have state, so try OpenStates.');
  
    openstates.geoLookup(geo.lat, geo.lng, function(err, stateReps) {
      if (err) {
          logger.info('getState had an error. Sending without.');
          sendResponse( recipient, '', reps, debug );
      }
  
      // debug('openstates response',stateReps);
      
      logger.info('OpenStates has reps.');

      if (typeof stateReps !== 'undefined') {
        each(stateReps, function ( item, eachStateRepCallback ){

          var title, order = '';
          if (item.chamber == 'upper') {
            title = 'State Sen.';
            order = 3;
          } else {  
            title = 'State Rep.';
            order = 4;
          }
          
          // DC has city council, not state legislators
          if ( item.state == 'dc' ) {
            title = 'Councilmember';
          }          

          if (typeof item.offices !== 'undefined' && typeof item.offices[0] !== 'undefined') {

            // need a better way to iterate to find phone
            var phone = item.offices[0].phone;
            if ((phone == null) && (typeof item.offices[1] !== 'undefined')) {
              phone = item.offices[1].phone;
            }
            if ((phone == null) && (typeof item.offices[2] !== 'undefined')) {
              phone = item.offices[2].phone;
            }
          
            reps.push({
              "name": title + ' ' + item.first_name + ' ' + item.last_name,
              "phone": phone,
              "order": order
            });
            
            eachStateRepCallback();
          } else {
            eachStateRepCallback();          
          }

        }, function done() {          
          //debug('stateReps',reps);
          sendResponse( recipient, '', reps, debug ); 
        });        

      } else {
          // log address and error.
          logger.info('OpenStates can\'t find reps for that address. Send without.');
          sendResponse( recipient, '', reps, debug );
      }
    });

}

 
 



// 
// Send Text Message Response
// 

function sendResponse( recipient, message, reps, debug ) {

  var greetings = ['Call your representatives:','Phone your reps:','They work for you!','Call your reps:'];

  if (reps) {
    reps = reps.sort(function(a, b) { return (a.order > b.order) ? 1 : ((a.order < b.order) ? -1 : 0); });

    if (reps.length == 1) { 
      message = 'Call your representative:\n';
    } else {
      message = greetings[Math.floor(Math.random() * greetings.length)] + '\n';      
    }

    reps.forEach( function ( item, pos ){
        message += item.name + ': ' + item.phone + "\n";
    });


  }


  var numberId = Math.floor(Math.random() * plivoOutbound.length);
  var outboundPhoneNumber = plivoOutbound[numberId];
  
//  if (numberId == 0) {
//    message += "\nHelp keep this service free: https://www.gofundme.com/smsbot";
//  }

  logger.info("textResponse:\n",message);
  
  var params = {
      'src': outboundPhoneNumber,
      'dst' : recipient,
      'text' : message
  };

  if (debug) {
      logger.info('Debug flag. No message sent.');
  } else {

    // Send the SMS to Plivo
    p.send_message(params, function (status, response) {
        logger.info('outboundPhoneNumber: ', outboundPhoneNumber);
        logger.info('Status: ', status);
        logger.info('API Response:\n', response);
    });

  } // end if debug

}
