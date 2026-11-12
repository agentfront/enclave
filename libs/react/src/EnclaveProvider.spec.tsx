/**
 * EnclaveProvider Tests
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { EnclaveProvider, useEnclaveClient, useEnclaveContext } from './EnclaveProvider';
import { EnclaveClient } from '@enclave-vm/client';

// Mock the EnclaveClient
jest.mock('@enclave-vm/client', () => ({
  EnclaveClient: jest.fn().mockImplementation((config) => ({
    config,
    execute: jest.fn(),
    executeStream: jest.fn(),
  })),
}));

describe('EnclaveProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should render children', () => {
    render(
      <EnclaveProvider config={{ baseUrl: 'https://api.example.com' }}>
        <div data-testid="child">Child Content</div>
      </EnclaveProvider>,
    );

    expect(screen.getByTestId('child')).toHaveTextContent('Child Content');
  });

  it('should create a client with the provided config', () => {
    const config = { baseUrl: 'https://api.example.com', timeout: 5000 };

    render(
      <EnclaveProvider config={config}>
        <div>Test</div>
      </EnclaveProvider>,
    );

    expect(EnclaveClient).toHaveBeenCalledWith(config);
  });

  it('should use provided client instead of creating one', () => {
    const mockClient = {
      execute: jest.fn(),
      executeStream: jest.fn(),
    } as unknown as EnclaveClient;

    render(
      <EnclaveProvider config={{ baseUrl: 'https://api.example.com' }} client={mockClient}>
        <div>Test</div>
      </EnclaveProvider>,
    );

    // EnclaveClient constructor should not be called when client is provided
    expect(EnclaveClient).not.toHaveBeenCalled();
  });

  it('should create client only once even on re-render', () => {
    const config = { baseUrl: 'https://api.example.com' };

    const { rerender } = render(
      <EnclaveProvider config={config}>
        <div>Test 1</div>
      </EnclaveProvider>,
    );

    rerender(
      <EnclaveProvider config={config}>
        <div>Test 2</div>
      </EnclaveProvider>,
    );

    // Client should only be created once
    expect(EnclaveClient).toHaveBeenCalledTimes(1);
  });

  it('should keep the client when a re-render brings an equal config object', () => {
    const { rerender } = render(
      <EnclaveProvider config={{ baseUrl: 'https://api.example.com', headers: { Authorization: 'Bearer a' } }}>
        <div>Test 1</div>
      </EnclaveProvider>,
    );

    rerender(
      <EnclaveProvider config={{ baseUrl: 'https://api.example.com', headers: { Authorization: 'Bearer a' } }}>
        <div>Test 2</div>
      </EnclaveProvider>,
    );

    expect(EnclaveClient).toHaveBeenCalledTimes(1);
  });

  it('should create a new client when the config values change', () => {
    const contexts: Array<{ client: unknown; config: unknown }> = [];
    function Capture() {
      contexts.push(useEnclaveContext());
      return null;
    }
    const first = { baseUrl: 'https://api.example.com', headers: { Authorization: 'Bearer a' } };
    const second = { baseUrl: 'https://api.example.com', headers: { Authorization: 'Bearer b' } };

    const { rerender } = render(
      <EnclaveProvider config={first}>
        <Capture />
      </EnclaveProvider>,
    );
    rerender(
      <EnclaveProvider config={second}>
        <Capture />
      </EnclaveProvider>,
    );

    expect(EnclaveClient).toHaveBeenCalledTimes(2);
    expect(EnclaveClient).toHaveBeenLastCalledWith(second);
    const latest = contexts[contexts.length - 1];
    expect(latest.config).toBe(second);
    expect(latest.client).not.toBe(contexts[0].client);
    expect((latest.client as { config: unknown }).config).toBe(second);
  });
});

describe('useEnclaveClient', () => {
  it('should return the client from context', () => {
    const mockClient = {
      execute: jest.fn(),
      executeStream: jest.fn(),
    } as unknown as EnclaveClient;

    let capturedClient: EnclaveClient | null = null;

    function TestComponent() {
      capturedClient = useEnclaveClient();
      return <div>Test</div>;
    }

    render(
      <EnclaveProvider config={{ baseUrl: 'https://api.example.com' }} client={mockClient}>
        <TestComponent />
      </EnclaveProvider>,
    );

    expect(capturedClient).toBe(mockClient);
  });

  it('should throw when used outside EnclaveProvider', () => {
    function TestComponent() {
      useEnclaveClient();
      return <div>Test</div>;
    }

    // Suppress console.error for this test
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {
      // Intentionally empty to suppress React error boundary output
    });

    expect(() => render(<TestComponent />)).toThrow('useEnclaveContext must be used within an EnclaveProvider');

    consoleSpy.mockRestore();
  });
});

describe('useEnclaveContext', () => {
  it('should return context with client and config', () => {
    const config = { baseUrl: 'https://api.example.com' };
    const mockClient = {
      execute: jest.fn(),
      executeStream: jest.fn(),
    } as unknown as EnclaveClient;

    let capturedClient: unknown = null;
    let capturedConfig: unknown = null;

    function TestComponent() {
      const ctx = useEnclaveContext();
      capturedClient = ctx.client;
      capturedConfig = ctx.config;
      return <div>Test</div>;
    }

    render(
      <EnclaveProvider config={config} client={mockClient}>
        <TestComponent />
      </EnclaveProvider>,
    );

    expect(capturedClient).toBe(mockClient);
    expect(capturedConfig).toBe(config);
  });

  it('should throw when used outside EnclaveProvider', () => {
    function TestComponent() {
      useEnclaveContext();
      return <div>Test</div>;
    }

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {
      // Intentionally empty to suppress React error boundary output
    });

    expect(() => render(<TestComponent />)).toThrow('useEnclaveContext must be used within an EnclaveProvider');

    consoleSpy.mockRestore();
  });
});
