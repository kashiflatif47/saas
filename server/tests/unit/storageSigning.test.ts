/**
 * Storage building blocks without any network: AWS SigV4 and Cloudinary signatures against the examples published
 * in their documentation, external-URL validation, SSRF address checks, and the production rule for local storage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_SHA256, presignUrl, signRequest } from '../../src/lib/storage/sigv4';
import { cloudinarySignature } from '../../src/lib/storage/providers';
import { fetchImageSafely, isPrivateAddress, validateExternalImageUrl } from '../../src/lib/storage/remote';
import { localStorageStatus } from '../../src/services/media';

const AWS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', now: new Date('2013-05-24T00:00:00Z') };

test('AWS SigV4: "GET Object" example from the S3 documentation', () => {
  const h = signRequest({ ...AWS, method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { range: 'bytes=0-9' }, payloadHash: EMPTY_SHA256 });
  assert.equal(h.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('AWS SigV4: presigned URL example from the S3 documentation', () => {
  const u = presignUrl({ ...AWS, method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', expiresSeconds: 86400 });
  assert.ok(u.endsWith('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'), u);
  assert.ok(u.startsWith('https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request'));
});

test('Cloudinary signature: example from the Cloudinary documentation', () => {
  assert.equal(cloudinarySignature({ eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop', public_id: 'sample_image', timestamp: 1315060510 }, 'abcd'), 'bfd09f95f331f558cbd1320e67aa8d488770583e');
});

test('external image links: https only, no unsafe protocols, credentials, IPs or internal names', () => {
  assert.equal(validateExternalImageUrl('https://images.example.com/biryani.jpg?w=800').hostname, 'images.example.com');
  for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'http://images.example.com/a.png', 'ftp://x.com/a.png', 'https://user:pw@x.com/a.png', 'https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://10.0.0.5/a.png', 'https://localhost/a.png', 'https://printer.local/a.png', 'https://intranet/a.png', 'https://x.com:8443/a.png', '/media/abc', '', 'not a url', `https://x.com/${'a'.repeat(2100)}`]) {
    assert.throws(() => validateExternalImageUrl(bad), Error, bad);
  }
});

test('SSRF guard: private, loopback, link-local, CGNAT and reserved addresses are refused', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1'])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '104.16.0.1', '172.32.0.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('import never connects to a host that resolves to a private address (DNS rebinding style)', async () => {
  await assert.rejects(fetchImageSafely('https://evil.example.com/a.png', { maxBytes: 1000, lookup: async () => [{ address: '169.254.169.254', family: 4 }] }), /private network/);
  await assert.rejects(fetchImageSafely('https://mixed.example.com/a.png', { maxBytes: 1000, lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }] }), /private network/);
  await assert.rejects(fetchImageSafely('https://nowhere.example.com/a.png', { maxBytes: 1000, lookup: async () => [] }), /could not be found/);
});

test('production refuses local uploads inside the app folder or without confirmed persistence', () => {
  const base = { appRoot: '/srv/app', cwd: '/srv/app/server' };
  assert.equal(localStorageStatus({ ...base, isProd: true, uploadDir: 'uploads', confirmedPersistent: true }).usable, false, 'relative = inside the app');
  assert.equal(localStorageStatus({ ...base, isProd: true, uploadDir: '/srv/app/server/uploads', confirmedPersistent: true }).usable, false, 'absolute but inside the app');
  assert.equal(localStorageStatus({ ...base, isProd: true, uploadDir: '/home/me/tablesaas-uploads', confirmedPersistent: false }).usable, false, 'outside but not confirmed');
  assert.deepEqual(localStorageStatus({ ...base, isProd: true, uploadDir: '/home/me/tablesaas-uploads', confirmedPersistent: true }), { usable: true, persistent: true, reason: '' });
  assert.equal(localStorageStatus({ ...base, isProd: false, uploadDir: 'uploads', confirmedPersistent: false }).usable, true, 'development keeps working');
});
