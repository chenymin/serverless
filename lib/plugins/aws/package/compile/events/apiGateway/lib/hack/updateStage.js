/* eslint-disable no-use-before-define */

'use strict';

const _ = require('lodash');
const BbPromise = require('bluebird');

// NOTE --> Keep this file in sync with ../stage.js

// NOTE: This code was written since there are problem setting up dedicated CloudFormation
// Stage resource (see https://github.com/serverless/serverless/pull/5692#issuecomment-467849311 for more information).

module.exports = {
  updateStage() {
    // this array is used to gather all the patch operations we need to
    // perform on the stage
    this.apiGatewayStagePatchOperations = [];

    return BbPromise.bind(this)
      .then(getAccountId)
      .then(handleTracing)
      .then(handleLogs)
      .then(handleTags)
      .then(getRestApiId)
      .then(applyUpdates);
  },
};

function getAccountId() {
  return this.provider.getAccountId().then((id) => this.accountId = id); // eslint-disable-line
}

function handleTracing() {
  const tracing = this.serverless.service.provider.tracing;
  const tracingEnabled = !_.isEmpty(tracing) && tracing.apiGateway;

  let operation = { op: 'replace', path: '/tracingEnabled', value: 'false' };
  if (tracingEnabled) {
    operation = { op: 'replace', path: '/tracingEnabled', value: 'true' };
  }
  this.apiGatewayStagePatchOperations.push(operation);
}

function handleLogs() {
  const logs = this.serverless.service.provider.apiGateway
    && this.serverless.service.provider.apiGateway.logs;
  const ops = this.apiGatewayStagePatchOperations;

  let dataTrace = { op: 'replace', path: '/*/*/logging/dataTrace', value: 'false' };
  let logLevel = { op: 'replace', path: '/*/*/logging/loglevel', value: 'OFF' };

  let operations = [dataTrace, logLevel];

  if (logs) {
    const service = this.serverless.service.service;
    const stage = this.options.stage;
    const region = this.options.region;
    const logGroupName = `/aws/api-gateway/${service}-${stage}`;

    // eslint-disable-next-line max-len
    const destinationArn = { op: 'replace', path: '/accessLogSettings/destinationArn', value: `arn:aws:logs:${region}:${this.accountId}:log-group:${logGroupName}` };
    // eslint-disable-next-line max-len
    const format = { op: 'replace', path: '/accessLogSettings/format', value: 'requestId: $context.requestId, ip: $context.identity.sourceIp, caller: $context.identity.caller, user: $context.identity.user, requestTime: $context.requestTime, httpMethod: $context.httpMethod, resourcePath: $context.resourcePath, status: $context.status, protocol: $context.protocol, responseLength: $context.responseLength' };
    dataTrace = { op: 'replace', path: '/*/*/logging/dataTrace', value: 'true' };
    logLevel = { op: 'replace', path: '/*/*/logging/loglevel', value: 'INFO' };
    operations = [destinationArn, format, dataTrace, logLevel];
  }

  ops.push.apply(ops, operations); // eslint-disable-line
}

function handleTags() {
  const provider = this.serverless.service.provider;
  const tagsMerged = [provider.stackTags, provider.tags].reduce((lastTags, newTags) => {
    if (_.isPlainObject(newTags)) {
      return _.extend(lastTags, newTags);
    }
    return lastTags;
  }, {});

  const tags = _.entriesIn(tagsMerged).map(pair => ({
    key: pair[0],
    value: pair[1],
  }));

  if (tags) {
    const that = this;
    tags.forEach((tag) => {
      const operation = { op: 'replace', path: `/variables/${tag.key}`, value: tag.value };
      that.apiGatewayStagePatchOperations.push(operation);
    });
  }
}

function getRestApiId() {
  const patchOperations = this.apiGatewayStagePatchOperations;

  if (patchOperations.length) {
    return this.provider.request('APIGateway', 'getRestApis', { limit: 5000 })
      .then((res) => {
        if (res.items.length) {
          const filteredRestApis = res.items.filter((api) =>
            api.name === `${this.options.stage}-${this.serverless.service.service}`);
          if (filteredRestApis.length) {
            const restApi = filteredRestApis.shift();
            return restApi.id;
          }
        }
        return null;
      })
      .then((restApiId) => {
        this.apiGatewayRestApiId = restApiId;
      });
  }

  return BbPromise.resolve();
}

function applyUpdates() {
  const restApiId = this.apiGatewayRestApiId;
  const patchOperations = this.apiGatewayStagePatchOperations;

  if (restApiId && patchOperations.length) {
    return this.provider.request('APIGateway', 'updateStage', {
      restApiId: this.apiGatewayRestApiId,
      stageName: this.options.stage,
      patchOperations,
    });
  }

  return BbPromise.resolve();
}
