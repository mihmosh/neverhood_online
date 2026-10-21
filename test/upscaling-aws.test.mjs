import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const directory = new URL('../tools/upscaling/realesrnet/aws/', import.meta.url);
const template = JSON.parse(await readFile(new URL('cloudformation.json', directory), 'utf8'));
const resources = template.Resources;
const properties = name => resources[name].Properties;
const statements = name => properties(name).Policies.flatMap(policy => policy.PolicyDocument.Statement);

test('AWS worker uses one isolated public subnet, no inbound access or NAT', () => {
  const types = Object.values(resources).map(resource => resource.Type);
  for (const type of ['VPC', 'Subnet', 'InternetGateway', 'Instance']) {
    assert.equal(types.filter(value => value === `AWS::EC2::${type}`).length, 1);
  }
  assert.equal(types.includes('AWS::EC2::NatGateway'), false);
  assert.equal(template.Parameters.AvailabilityZone.Default, 'us-east-2a');
  assert.deepEqual(properties('PublicSubnet').AvailabilityZone, { Ref: 'AvailabilityZone' });
  assert.equal(properties('PublicSubnet').MapPublicIpOnLaunch, true);
  assert.equal(properties('InternetRoute').DestinationCidrBlock, '0.0.0.0/0');
  assert.equal(resources.InternetRoute.DependsOn, 'GatewayAttachment');
  assert.deepEqual(properties('WorkerSecurityGroup').SecurityGroupIngress, []);
  assert.deepEqual(properties('WorkerSecurityGroup').SecurityGroupEgress, [
    { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
    { IpProtocol: 'udp', FromPort: 53, ToPort: 53, CidrIp: '10.42.0.2/32' },
    { IpProtocol: 'tcp', FromPort: 53, ToPort: 53, CidrIp: '10.42.0.2/32' },
  ]);
});

test('L4 instance has encrypted disposable root, IMDSv2 and only minimal SSM bootstrap', async () => {
  const instance = properties('WorkerInstance');
  assert.equal(instance.InstanceType, 'g6.2xlarge');
  assert.equal(template.Parameters.ImageId.Default, 'ami-08c796f166a9277af');
  assert.deepEqual(instance.ImageId, { Ref: 'ImageId' });
  assert.equal(template.Parameters.RootDeviceName.Default, '/dev/sda1');
  assert.deepEqual(instance.BlockDeviceMappings, [{
    DeviceName: { Ref: 'RootDeviceName' },
    Ebs: { VolumeType: 'gp3', VolumeSize: 150, Encrypted: true, DeleteOnTermination: true },
  }]);
  assert.equal(instance.MetadataOptions.HttpTokens, 'required');
  assert.equal(instance.MetadataOptions.HttpPutResponseHopLimit, 1);
  assert.equal('KeyName' in instance, false);
  const [separator, lines] = instance.UserData['Fn::Base64']['Fn::Join'];
  const bootstrap = await readFile(new URL('bootstrap.sh', directory), 'utf8');
  assert.equal(lines.join(separator), bootstrap, 'standalone bootstrap and embedded UserData must match');
  assert.match(bootstrap, /install -d -o ubuntu -g ubuntu -m 0750 \/opt\/neverhood-upscaling/);
  assert.match(bootstrap, /systemctl enable --now snap\.amazon-ssm-agent/);
  assert.doesNotMatch(bootstrap, /curl|wget|https?:|pip |huggingface|git clone|aws /i);
});

test('private versioned bucket survives stack deletion and replacement', () => {
  const bucket = resources.StorageBucket;
  assert.equal(bucket.DeletionPolicy, 'Retain');
  assert.equal(bucket.UpdateReplacePolicy, 'Retain');
  assert.equal('BucketName' in bucket.Properties, false);
  assert.equal(bucket.Properties.VersioningConfiguration.Status, 'Enabled');
  assert.equal(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm, 'AES256');
  assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true,
  });
  assert.deepEqual(bucket.Properties.OwnershipControls.Rules, [{ ObjectOwnership: 'BucketOwnerEnforced' }]);
});

test('worker can read sources and only write its own private results prefix', () => {
  const role = properties('WorkerRole');
  assert.equal(role.ManagedPolicyArns, undefined);
  assert.doesNotMatch(JSON.stringify(role), /ssm:GetParameter|secretsmanager:/);
  assert.match(JSON.stringify(role), /ssmmessages:OpenControlChannel/);
  const policy = role.Policies.find(item => item.PolicyName === 'PrivateUpscalingStorage').PolicyDocument.Statement;
  assert.equal(policy.length, 4);
  assert.deepEqual(policy[0], { Effect: 'Allow', Action: 's3:GetBucketLocation', Resource: { 'Fn::GetAtt': ['StorageBucket', 'Arn'] } });
  assert.deepEqual(policy[1].Condition.StringLike['s3:prefix'], [
    'sources/', 'sources/*', { 'Fn::Sub': 'results/${AWS::StackName}/' }, { 'Fn::Sub': 'results/${AWS::StackName}/*' },
  ]);
  assert.equal(policy[1].Action, 's3:ListBucket');
  assert.deepEqual(policy[1].Resource, { 'Fn::GetAtt': ['StorageBucket', 'Arn'] });
  assert.deepEqual(policy[2], { Effect: 'Allow', Action: 's3:GetObject', Resource: { 'Fn::Sub': '${StorageBucket.Arn}/sources/*' } });
  assert.deepEqual(policy[3].Action, ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts']);
  assert.deepEqual(policy[3].Resource, { 'Fn::Sub': '${StorageBucket.Arn}/results/${AWS::StackName}/*' });
  assert.doesNotMatch(JSON.stringify(role), /cloudfront:|releases\/|s3:\*/);
});

test('only the OAC distribution can read published demo objects, never private inputs/results', () => {
  const policy = properties('StorageBucketPolicy').PolicyDocument.Statement;
  assert.equal(policy.length, 2);
  assert.equal(policy[0].Effect, 'Deny');
  assert.deepEqual(policy[0].Condition, { Bool: { 'aws:SecureTransport': 'false' } });
  assert.deepEqual(policy[1], {
    Sid: 'OnlyDemoDistributionCanReadPublishedDemo', Effect: 'Allow',
    Principal: { Service: 'cloudfront.amazonaws.com' }, Action: 's3:GetObject',
    Resource: { 'Fn::Sub': '${StorageBucket.Arn}/releases/hd-demo/*' },
    Condition: { StringEquals: { 'AWS:SourceArn': { 'Fn::Sub': 'arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${DemoDistribution}' } } },
  });
  const oac = properties('DemoOriginAccessControl').OriginAccessControlConfig;
  assert.equal(oac.OriginAccessControlOriginType, 's3');
  assert.equal(oac.SigningBehavior, 'always');
  assert.equal(oac.SigningProtocol, 'sigv4');
  const config = properties('DemoDistribution').DistributionConfig;
  assert.equal(config.PriceClass, 'PriceClass_100');
  assert.equal('Logging' in config, false);
  assert.deepEqual(config.Origins, [{
    Id: 'PrivateDemoS3', DomainName: { 'Fn::GetAtt': ['StorageBucket', 'RegionalDomainName'] },
    OriginPath: '/releases/hd-demo', OriginAccessControlId: { Ref: 'DemoOriginAccessControl' },
    S3OriginConfig: { OriginAccessIdentity: '' },
  }]);
  for (const behavior of [config.DefaultCacheBehavior, ...config.CacheBehaviors]) {
    assert.equal(behavior.ViewerProtocolPolicy, 'redirect-to-https');
    assert.deepEqual(behavior.AllowedMethods, ['GET', 'HEAD', 'OPTIONS']);
    assert.deepEqual(behavior.OriginRequestPolicyId, { Ref: 'DemoOriginRequestPolicy' });
    assert.deepEqual(behavior.CachedMethods, ['GET', 'HEAD']);
    assert.equal(behavior.Compress, true);
    assert.deepEqual(behavior.ResponseHeadersPolicyId, { Ref: 'DemoResponseHeaders' });
  }
  assert.deepEqual(config.DefaultCacheBehavior.CachePolicyId, { Ref: 'DemoCachePolicy' });
  assert.equal(properties('DemoCachePolicy').CachePolicyConfig.DefaultTTL, 86400);
  assert.equal(config.CacheBehaviors[0].PathPattern, '*.json');
  assert.equal(config.CacheBehaviors[0].CachePolicyId, '4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
  const headers = properties('DemoResponseHeaders').ResponseHeadersPolicyConfig;
  assert.deepEqual(headers.CorsConfig.AccessControlAllowOrigins.Items, ['*']);
  assert.deepEqual(headers.CorsConfig.AccessControlAllowMethods.Items, ['GET', 'HEAD', 'OPTIONS']);
  assert.equal(headers.CorsConfig.AccessControlAllowCredentials, false);
  assert.equal(headers.CorsConfig.OriginOverride, true);
  assert.deepEqual(headers.SecurityHeadersConfig.ContentTypeOptions, { Override: true });
  assert.deepEqual(headers.CustomHeadersConfig.Items, [{ Header: 'Cross-Origin-Resource-Policy', Value: 'cross-origin', Override: true }]);
  assert.doesNotMatch(JSON.stringify(headers), /Cross-Origin-Embedder-Policy/);
});

test('one-shot UTC scheduler can stop only this instance and cannot delete storage', () => {
  assert.equal('Default' in template.Parameters.AutoStopAt, false);
  assert.match('2026-10-21T23:00:00', new RegExp(`^${template.Parameters.AutoStopAt.AllowedPattern}$`));
  const schedule = properties('AutoStopSchedule');
  assert.deepEqual(schedule.ScheduleExpression, { 'Fn::Sub': 'at(${AutoStopAt})' });
  assert.equal(schedule.ScheduleExpressionTimezone, 'UTC');
  assert.equal('ActionAfterCompletion' in schedule, false, 'unsupported CloudFormation property must not block deployment');
  assert.match(template.Metadata.AutoStopScheduleCleanup, /ActionAfterCompletion=DELETE/);
  assert.deepEqual(schedule.FlexibleTimeWindow, { Mode: 'OFF' });
  assert.deepEqual(schedule.Target.Arn, { 'Fn::Sub': 'arn:${AWS::Partition}:scheduler:::aws-sdk:ec2:stopInstances' });
  assert.deepEqual(schedule.Target.Input, { 'Fn::Sub': '{"InstanceIds":["${WorkerInstance}"]}' });
  assert.deepEqual(schedule.Target.RoleArn, { 'Fn::GetAtt': ['AutoStopRole', 'Arn'] });
  const trust = properties('AutoStopRole').AssumeRolePolicyDocument.Statement;
  assert.deepEqual(trust, [{ Effect: 'Allow', Principal: { Service: 'scheduler.amazonaws.com' }, Action: 'sts:AssumeRole', Condition: { StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } } }]);
  assert.deepEqual(statements('AutoStopRole'), [{ Effect: 'Allow', Action: 'ec2:StopInstances', Resource: { 'Fn::Sub': 'arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:instance/${WorkerInstance}' } }]);
  assert.deepEqual(Object.keys(template.Outputs).sort(), ['AutoStopAt', 'AutoStopScheduleName', 'BucketName', 'DemoManifestURL', 'DistributionId', 'InstanceId']);
  assert.deepEqual(template.Outputs.DemoManifestURL.Value, { 'Fn::Sub': 'https://${DemoDistribution.DomainName}/v1/manifest.json' });
});

test('native template references exist and its resource dependency graph has no cycles', () => {
  assert.equal(template.AWSTemplateFormatVersion, '2010-09-09');
  assert.equal('Transform' in template, false);
  const graph = new Map(Object.keys(resources).map(name => [name, new Set()]));
  const known = name => name.startsWith('AWS::') || name in resources || name in template.Parameters;
  function inspect(value, edges) {
    if (!value || typeof value !== 'object') return;
    if (value.Ref) {
      assert.ok(known(value.Ref), `unknown Ref ${value.Ref}`);
      if (graph.has(value.Ref)) edges.add(value.Ref);
    }
    if (value['Fn::GetAtt']) {
      const name = Array.isArray(value['Fn::GetAtt']) ? value['Fn::GetAtt'][0] : value['Fn::GetAtt'].split('.')[0];
      assert.ok(name in resources, `unknown GetAtt ${name}`);
      edges.add(name);
    }
    if (typeof value['Fn::Sub'] === 'string') {
      for (const [, reference] of value['Fn::Sub'].matchAll(/\$\{([^!}][^}]*)\}/g)) {
        const name = reference.split('.')[0];
        assert.ok(known(name), `unknown Sub ${name}`);
        if (graph.has(name)) edges.add(name);
      }
    }
    for (const child of Object.values(value)) inspect(child, edges);
  }
  for (const [name, resource] of Object.entries(resources)) {
    const edges = graph.get(name);
    inspect(resource.Properties, edges);
    for (const dependency of [resource.DependsOn ?? []].flat()) {
      assert.ok(dependency in resources);
      edges.add(dependency);
    }
    if (resource.Properties.Tags) {
      assert.ok(resource.Properties.Tags.some(tag => tag.Key === 'Project' && tag.Value === 'neverhood'));
      assert.ok(resource.Properties.Tags.some(tag => tag.Key === 'Purpose' && tag.Value === 'upscaling'));
    }
  }
  const visited = new Set();
  function visit(name, path = []) {
    assert.equal(path.includes(name), false, `dependency cycle: ${[...path, name].join(' -> ')}`);
    if (visited.has(name)) return;
    for (const dependency of graph.get(name)) visit(dependency, [...path, name]);
    visited.add(name);
  }
  for (const name of graph.keys()) visit(name);
  inspect(template.Outputs, new Set());
});
