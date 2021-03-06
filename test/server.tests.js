var LimitdServer = require('..').Server;
var LimitdClient = require('..').Client;

var assert = require('chai').assert;
var expect = require('chai').expect;
var rimraf = require('rimraf');
var path   = require('path');
var client;

var async = require('async');
var _ = require('lodash');

describe('limitd server', function () {
  var server;

  before(function (done) {
    var db_file = path.join(__dirname, 'dbs', 'server.tests.db');

    try{
      rimraf.sync(db_file);
    } catch(err){}

    server = new LimitdServer(_.extend({db: db_file}, require('./fixture')));

    server.start(function (err, address) {
      if (err) return done(err);
      client = new LimitdClient(address);
      client.once('connect', done);
    });
  });

  after(function () {
    server.stop();
  });

  afterEach(function () {
    if (Date.unfix) { Date.unfix(); }
  });

  describe('TAKE', function () {
    it('should work with a simple request', function (done) {
      var now = 1425920267;
      Date.fix(now);
      client.take('ip', '211.123.12.12', function (err, response) {
        if (err) return done(err);
        assert.ok(response.conformant);
        assert.equal(response.remaining, 9);
        assert.equal(response.reset, now + 1);
        assert.equal(response.limit, 10);
        done();
      });
    });

    it('should work with a fixed bucket', function (done) {
      async.map(_.range(0, 3), function (i, cb) {
        client.take('wrong_password', 'tito', cb);
      }, function (err, results) {
        if (err) return done(err);
        assert.ok(results.every(function (r) {
          return r.conformant;
        }));
        client.take('wrong_password', 'tito', function (err, response) {
          assert.notOk(response.conformant);
          done();
        });
      });
    });

    it('should return false when traffic is not conformant', function (done) {
      async.each(_.range(0, 10), function (i, cb) {
        client.take('ip', '211.123.12.24', cb);
      }, function (err) {
        if (err) return done(err);
        client.take('ip', '211.123.12.24', function (err, response) {
          assert.notOk(response.conformant);
          done();
        });
      });
    });

    it('should be conformant if an override allows it', function (done) {
      async.each(_.range(0, 10), function (i, cb) {
        client.take('ip', '127.0.0.1', cb);
      }, function (err) {
        if (err) return done(err);
        client.take('ip', '127.0.0.1', function (err, response) {
          assert.ok(response.conformant);
          done();
        });
      });
    });

    it('should use seconds ceiling for next reset', function (done) {
      // it takes ~1790 msec to fill the bucket with this test
      var now = 1425920267;
      Date.fix(now);
      var requests = _.map(_.range(0, 9), function(){
        return function (cb) {
          client.take('ip', '211.123.12.36', cb);
        };
      });
      async.series(requests, function (err, results) {
        if (err) return done(err);
        var lastResponse = results[results.length -1];
        if (err) return done(err);
        assert.ok(lastResponse.conformant);
        assert.equal(lastResponse.remaining, 1);
        assert.equal(lastResponse.reset, now + 2);
        assert.equal(lastResponse.limit, 10);
        done();
      });
    });

    it('should set reset to UNIX timestamp regardless of period', function(done){
      var now = 1425920267;
      Date.fix(now);
      client.take('ip', '10.0.0.1', function (err, response) {
        if (err) { return done(err); }
        assert.ok(response.conformant);
        assert.equal(response.remaining, 0);
        assert.equal(response.reset, now + 1800);
        assert.equal(response.limit, 1);
        done();
      });
    });
  });

  describe('WAIT', function () {
    it('should work with a simple request', function (done) {
      var now = 1425920267;
      Date.fix(now);
      client.wait('ip', '211.76.23.4', function (err, response) {
        if (err) return done(err);
        assert.ok(response.conformant);
        assert.notOk(response.delayed);


        assert.equal(response.remaining, 9);
        assert.equal(response.reset, now + 1);

        done();
      });
    });


    it('should be delayed when traffic is non conformant', function (done) {
      client.take('ip', '211.76.23.5', 10, function (err) {
        if (err) return done(err);
        var waitingSince = Date.now();
        client.wait('ip', '211.76.23.5', 3, function (err, response) {
          var waited = Date.now() - waitingSince;
          console.log('waited', waited);
          assert.ok(response.conformant);
          assert.ok(response.delayed);
          expect(waited).to.be.closeTo(600, 10);
          done();
        });
      });
    });
  });

  it('should fail when the bucket type doesnt exist', function (done) {
    client.take('blabla', '211.123.12.12', function (err) {
      assert.equal(err.message, 'blabla is not a valid bucket type');
      done();
    });
  });

  it('should autoremove unused buckets', function (done) {
    client.take('ip', '211.45.66.1', function (err) {
      if (err) return done(err);
      setTimeout(function () {
        server._db.get('ÿipÿ211.45.66.1', function (err, result) {
          assert.isUndefined(result);
          done();
        });
      }, 2200);
    });
  });


  describe('PUT', function () {
    it('should restore the bucket when reseting', function (done) {
      client.take('ip', '211.123.12.12', function (err, response) {
        if (err) return done(err);
        client.put('ip', '211.123.12.12', function (err, response) {
          if (err) return done(err);
          client.take('ip', '211.123.12.12', function (err, response) {
            if (err) return done(err);
            assert.equal(response.remaining, 9);
            done();
          });
        });
      });
    });

    it('should be able to reset without callback', function (done) {
      client.take('ip', '211.123.5.12', function (err, response) {
        if (err) return done(err);

        client.put('ip', '211.123.5.12', 1);

        setTimeout(function (){
          client.take('ip', '211.123.5.12', function (err, response) {
            if (err) return done(err);
            assert.equal(response.remaining, 9);
            done();
          });
        }, 100);
      });
    });

    it('should be able to fully reset the bucket', function (done) {
      client.take('ip', '211.1.1.12', 5, function (err, response) {
        if (err) return done(err);
        assert.equal(response.remaining, 5);

        client.put('ip', '211.1.1.12', function (err, response) {
          if (err) return done(err);
          assert.equal(response.remaining, 10);

          client.take('ip', '211.1.1.12', function (err, response) {
            if (err) return done(err);
            assert.equal(response.remaining, 9);
            done();
          });
        });
      });
    });

  });

  describe('STATUS', function () {

    it('should work', function (done) {
      var ip = '211.11.84.12';

      client.take('ip', ip, function (err) {
        if (err) return done(err);
        client.status('ip', ip, function (err, response) {
          if (err) return done(err);
          assert.equal(response.items[0].remaining, 9);
          done();
        });
      });
    });

    it('should work with subclasses', function (done) {

      async.series([
        function (cb) { client.take('ip', 'class1|192.123.21.1', cb); },
        function (cb) { client.take('ip', 'class1|192.123.21.2', cb); },
        function (cb) { client.take('ip', 'class1|192.123.21.2', cb); },
        function (cb) { client.take('ip', 'class2|192.123.21.3', cb); },
      ], function (err) {
        if (err) return done(err);
        //this will retrieve all bucket instances of ip - class1
        client.status('ip', 'class1', function (err, response) {
          if (err) return done(err);
          assert.equal(response.items.length, 2);
          assert.equal(response.items[0].remaining, 9);
          assert.equal(response.items[0].instance, 'class1|192.123.21.1');
          assert.equal(response.items[1].remaining, 8);
          assert.equal(response.items[1].instance, 'class1|192.123.21.2');
          done();
        });
      });

    });

  });

});