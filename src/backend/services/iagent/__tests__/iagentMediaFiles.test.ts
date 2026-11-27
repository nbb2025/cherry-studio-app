import { File } from 'expo-file-system';

import { saveVideoResponse } from '../iagentMediaFiles';

const mockMove = jest.fn();
const mockDelete = jest.fn();

jest.mock('expo-file-system', () => ({
  File: jest.fn(() => ({
    name: 'video.mp4',
    parentDirectory: { uri: 'file:///fixture' },
    create: jest.fn(),
    exists: true,
    writableStream: () => new WritableStream<Uint8Array>(),
    move: mockMove,
    delete: mockDelete,
  })),
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

test('rejects and removes the partial video if publishing the file fails asynchronously', async () => {
  const error = new Error('Unable to move video into place');
  const failedMove = Promise.reject(error);
  void failedMove.catch(() => undefined);
  mockMove.mockReturnValueOnce(failedMove);

  const response = new Response(new Uint8Array([1, 2, 3]), {
    headers: { 'Content-Type': 'video/mp4' },
  });
  const destination = new File('file:///fixture/video.mp4');
  await expect(saveVideoResponse(response, destination, new AbortController().signal)).rejects.toBe(
    error,
  );
  expect(mockDelete).toHaveBeenCalledTimes(1);
});
