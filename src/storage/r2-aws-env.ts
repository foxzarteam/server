/** Must load before @aws-sdk/client-s3 so R2 PutObject is not signed with CRC32. */
process.env.AWS_REQUEST_CHECKSUM_CALCULATION = 'WHEN_REQUIRED';
process.env.AWS_RESPONSE_CHECKSUM_VALIDATION = 'WHEN_REQUIRED';
