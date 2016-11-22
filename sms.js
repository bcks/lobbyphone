var express     = require('express'),
    app         = express(),
    server      = require('http').createServer(app),
    winston     = require('winston'),
    async       = require('async'),
    request     = require('request'),
    OpenStates  = require('openstates'),
    plivo       = require('plivo'),
    config      = require('./config.js'),
    port        = config.port;



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
  transports: [
    new (winston.transports.Console)({ json: false, timestamp: true }),
    // new winston.transports.File({ filename: __dirname + '/log/debug.log', json: false })
  ],
  exceptionHandlers: [
    new (winston.transports.Console)({ json: false, timestamp: true }),
    // new winston.transports.File({ filename: __dirname + '/log/exceptions.log', json: false })
  ],
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
  var niceWords = ['nice','cool','neat','this is awesome'];
  var thanksWords = ['thanks','thank you'];

  if ( niceWords.indexOf( incoming.text.toLowerCase().replace(/[.!]/g,"") ) > -1 ) {
    sendResponse( incoming.from, "Thanks!", null, incoming.debug );

  } else if ( thanksWords.indexOf( incoming.text.toLowerCase().replace(/[.!]/g,"") ) > -1 ) {
    sendResponse( incoming.from, "You're welcome!", null, incoming.debug );

  } else if (testWords.indexOf( incoming.text.toLowerCase().replace(/[.!]/g,"") ) > -1 ) {
    sendResponse( incoming.from, 'Hi! Text me a US postal address and I will send back phone numbers for your state and federal legislators.', null, incoming.debug );

  } else {
    geocode( incoming.from, incoming.text, incoming.debug );
  }


} // end receiveSMS





//
// Geocode Postal Address
// 

function geocode( recipient, address, debug ) {
  
  logger.info('geocoder got address:',address);


  // first try geocode with Google:

  var url = 'https://maps.googleapis.com/maps/api/geocode/json?address='+address+'&key='+config.googleAPI;

  request(url, function (err, response, body) {
    if (err) {
      logger.info('Google maps error:', body);
      sendResponse( recipient, "I'm sorry, I don't understand that address. Would you try writing it a different way?", null, debug );
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
      request(url, function (err, response, body) {
        if (err) {
          logger.info('MapQuest error:', body);
          sendResponse( recipient, "I'm sorry, I don't understand that address. Would you try writing it a different way?", null, debug );
        }
        data = JSON.parse(body);

        var address_components = JSON.stringify(data.results[0].locations[0]);

        if ( address_components.indexOf("US") > -1)  {
          var geo = data.results[0].locations[0].latLng;
          logger.info('geo:',geo);
          getReps( recipient, geo, address, debug );
        } else {
          logger.info('Not US. MapQuest address components:',address_components);
          sendResponse( recipient, "I'm sorry, I can't find that address within the U.S.", null, debug );
        }
    
      }); // end mapquest request

    } // end no results from Google

  });

}






//
// Get Representatives
// 

function getReps( recipient, geo, address, debug ) {

    var url = 'https://www.googleapis.com/civicinfo/v2/representatives?address='+geo.lat+'%2C'+geo.lng+'&levels=country&levels=administrativeArea1&roles=legislatorLowerBody&roles=legislatorUpperBody&fields=offices%2Cofficials(name%2Cparty%2Cphones)&key='+config.googleAPI;

    request(url, function (err, response, body) {
        
        body = JSON.parse(body);

        if ((err) || (typeof body.error !== 'undefined')) {        
          logger.info('getReps can\'t find reps for that address.');
          
          if ( /^\d+$/.test(address) ) {
            sendResponse( recipient, "I'm sorry, sometimes zip code alone does not work. Try again with a postal address?", null, debug );
          } else {
            sendResponse( recipient, "I'm sorry, I can't find representatives for that address.", null, debug );          
          }

        } else {

          logger.info('Got reps.');
          //debug(body);
          
          var reps = [];
          var n = -1;
          var hasState = 0;

          async.each(body.officials, function ( thisRep, thisRepCallback ){
              var title, order = '';
              n++;
              
              if (thisRep.name == 'Vacant') {

                thisRepCallback();

              } else {
              
                async.each(body.offices, function ( thisOffice, thisOfficeCallback ){
              
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

      } // end if
    }); // end request
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
        async.each(stateReps, function ( item, eachStateRepCallback ){

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

          if (typeof item.offices !== 'undefined') {

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

  if (reps) {
    reps = reps.sort(function(a, b) { return (a.order > b.order) ? 1 : ((a.order < b.order) ? -1 : 0); });

    if (reps.length == 1) { 
      message = 'Call your representative:\n';
    } else {
      message = 'Call your representatives:\n';      
    }

    reps.forEach( function ( item, pos ){
        message += item.name + ': ' + item.phone + "\n";
    });
  }

  logger.info("textResponse:\n",message);

  var params = {
      'src': '15202002223 ',
      'dst' : recipient,
      'text' : message
  };


  if (debug) {
      logger.info('Debug flag. No message sent.');
  } else {

    // Send the SMS to Plivo
    p.send_message(params, function (status, response) {
        logger.info('Status: ', status);
        logger.info('API Response:\n', response);
    });

  }

}
