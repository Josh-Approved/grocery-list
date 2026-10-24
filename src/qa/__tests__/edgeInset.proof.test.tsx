/**
 * Canonical, app-agnostic — synced by `sync.mjs qa`; do not fork.
 *
 * The proof half of the edge-inset audit. A gate that never demonstrated
 * failure is a hope, not a gate, so this file pins the shape that shipped —
 * workout-timer's Settings "Sounds" card (2026-10): a DrilldownRow dropped
 * straight into a card, so "Warm up start" touched the card's left border and
 * the chevron its right one — next to the shapes the audit must leave alone.
 *
 * This app's own screens are audited in edgeInset.screens.test.tsx, which the
 * app owns.
 */

import React from 'react';
import { View, Text, TextInput, Pressable, ScrollView } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { auditScreen } from '../edgeInsetAudit';
import { MIN_EDGE_INSET } from '../edgeInset';

const card = { backgroundColor: '#fff', borderWidth: 1, borderColor: '#ddd' };

/** DrilldownRow as it shipped: label, value, chevron, and no horizontal padding of its own. */
function ShippedRow({ label, value }: { label: string; value: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 50,
        borderBottomWidth: 0.5,
        borderBottomColor: '#ddd',
      }}
    >
      <Text>{label}</Text>
      <Text style={{ flex: 1, textAlign: 'right' }}>{value}</Text>
      <ChevronRight size={18} color="#888" />
    </Pressable>
  );
}

describe('edge-inset audit — catches what shipped', () => {
  it('flags a row dropped straight into a card (the Sounds card defect)', async () => {
    const findings = await auditScreen(
      <View style={card}>
        <ShippedRow label="Warm up start" value="Voice" />
      </View>
    );
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: 'Warm up start', edge: 'start', inset: 0 }),
      ])
    );
    // The chevron hugs the right border the same way.
    expect(findings.some((f) => f.edge === 'end' && f.content !== 'Warm up start')).toBe(true);
  });

  it('passes the same row once the card supplies a gutter', async () => {
    const findings = await auditScreen(
      <View style={card}>
        <View style={{ paddingHorizontal: 16 }}>
          <ShippedRow label="Warm up start" value="Voice" />
        </View>
      </View>
    );
    expect(findings).toEqual([]);
  });

  it('flags a button label with too little padding, and ignores content that never reaches an edge', async () => {
    const findings = await auditScreen(
      <View>
        <Pressable style={{ backgroundColor: '#000', paddingHorizontal: MIN_EDGE_INSET - 4 }}>
          <Text>Too tight</Text>
        </Pressable>
        <View style={{ ...card, alignItems: 'center' }}>
          <Text>Centered</Text>
        </View>
        <View style={{ ...card, flexDirection: 'row', paddingHorizontal: 16 }}>
          <Text>Left</Text>
          <Text>Middle (never reaches an edge)</Text>
          <Text>Right</Text>
        </View>
      </View>
    );
    expect(findings.map((f) => f.content)).toEqual(['Too tight', 'Too tight']);
  });

  it('ignores a fill that matches what is behind it (no visible edge), but not a different one', async () => {
    const findings = await auditScreen(
      <View style={{ backgroundColor: '#fff' }}>
        <View style={{ paddingHorizontal: 16 }}>
          {/* A swipe row's content layer, painted the screen colour to hide its action. */}
          <View style={{ backgroundColor: '#fff' }}>
            <Text>Camouflaged</Text>
          </View>
          <View style={{ backgroundColor: '#f2f2f2' }}>
            <Text>Tinted card</Text>
          </View>
        </View>
      </View>
    );
    expect(findings.map((f) => `${f.content}:${f.edge}`)).toEqual(['Tinted card:start', 'Tinted card:end']);
  });

  it('judges a filled input by its own padding, and a bare input like text', async () => {
    const findings = await auditScreen(
      <View style={{ ...card, paddingHorizontal: 16 }}>
        <TextInput style={{ backgroundColor: '#eee', paddingHorizontal: 2 }} placeholder="Cramped" />
        <TextInput style={{ backgroundColor: '#eee', paddingHorizontal: 12 }} placeholder="Roomy" />
        <TextInput placeholder="Bare, in the card gutter" />
      </View>
    );
    expect(findings).toEqual([
      { content: 'TextInput "Cramped"', edge: 'start', inset: 2 },
      { content: 'TextInput "Cramped"', edge: 'end', inset: 2 },
    ]);
  });

  it('refuses to pass a render with nothing on it (a sheet left closed)', async () => {
    await expect(auditScreen(<View style={card} />)).rejects.toThrow(/nothing to audit/);
  });

  it("counts a ScrollView's contentContainerStyle padding (it lives on the inner view on device)", async () => {
    const findings = await auditScreen(
      <ScrollView style={{ backgroundColor: '#fff' }} contentContainerStyle={{ paddingHorizontal: 16 }}>
        <Text>Inside the scroll gutter</Text>
      </ScrollView>
    );
    expect(findings).toEqual([]);
  });
});
