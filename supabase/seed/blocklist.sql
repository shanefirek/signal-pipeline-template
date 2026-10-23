-- Seed domain_blocklist from growth-ops/config/blocklist.json
-- 50 domains across 4 categories
-- Run once during project setup

INSERT INTO domain_blocklist (domain, reason) VALUES
  -- Partners (3)
  ('starbridge.ai', 'partner'),
  ('digital-made.com', 'partner'),
  ('octave.is', 'partner'),

  -- Internal (1)
  ('acmegtm.com', 'internal'),

  -- Closed Lost (14)
  ('civilmafia.com', 'closed_lost'),
  ('edthena.com', 'closed_lost'),
  ('eluma.com', 'closed_lost'),
  ('elumatherapy.com', 'closed_lost'),
  ('frizzle.com', 'closed_lost'),
  ('futurevaultinc.com', 'closed_lost'),
  ('galileo-learning.com', 'closed_lost'),
  ('iamcultured.co', 'closed_lost'),
  ('iboss.com', 'closed_lost'),
  ('parseceducation.com', 'closed_lost'),
  ('readablenglish.com', 'closed_lost'),
  ('storytimeaiapp.com', 'closed_lost'),
  ('exampleco.com', 'closed_lost'),
  ('topia.io', 'closed_lost'),

  -- Customers (32)
  ('1stmakerspace.com', 'customer'),
  ('bes.org', 'customer'),
  ('circuitiq.com', 'customer'),
  ('codehs.com', 'customer'),
  ('cybernut.com', 'customer'),
  ('cybernut.ai', 'customer'),
  ('educationalresourcecompany.com', 'customer'),
  ('everydayspeech.com', 'customer'),
  ('gearbyfuzion.com', 'customer'),
  ('harriseducationsolutions.com', 'customer'),
  ('impactlearn.com', 'customer'),
  ('mykaleidoscope.com', 'customer'),
  ('maialearning.com', 'customer'),
  ('mission.io', 'customer'),
  ('myabt.com', 'customer'),
  ('nidolearning.com', 'customer'),
  ('partnerfleet.io', 'customer'),
  ('pathwisek12.com', 'customer'),
  ('getprodocks.com', 'customer'),
  ('pblworks.org', 'customer'),
  ('reddrop.co', 'customer'),
  ('scantron.com', 'customer'),
  ('simpliworks.io', 'customer'),
  ('spureducation.com', 'customer'),
  ('suraasa.com', 'customer'),
  ('tassel.com', 'customer'),
  ('the-commons.app', 'customer'),
  ('timelyschools.com', 'customer'),
  ('transact.com', 'customer'),
  ('transfrinc.com', 'customer'),
  ('truthtree.com', 'customer'),
  ('uptickhq.com', 'customer')
ON CONFLICT (domain) DO NOTHING;
