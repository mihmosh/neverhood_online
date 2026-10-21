"""Local operator SDK session. Never serialize or print the exported credentials."""
import json
import subprocess
import boto3


def operator_session(profile, region, account):
    credentials = json.loads(subprocess.check_output(
        ['aws', 'configure', 'export-credentials', '--profile', profile, '--format', 'process'], text=True))
    session = boto3.Session(aws_access_key_id=credentials['AccessKeyId'],
                            aws_secret_access_key=credentials['SecretAccessKey'],
                            aws_session_token=credentials.get('SessionToken'), region_name=region)
    if session.client('sts').get_caller_identity()['Account'] != account:
        raise RuntimeError('Refusing an AWS account different from the deployment record')
    return session
