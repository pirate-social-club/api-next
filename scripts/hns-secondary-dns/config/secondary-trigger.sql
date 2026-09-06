CREATE TRIGGER pirate_secondary_readiness_tsig_axfr_v1
AFTER INSERT ON domains
WHEN NEW.type = 'SLAVE'
BEGIN
  INSERT INTO domainmetadata (domain_id, kind, content)
  SELECT NEW.id, 'TSIG-ALLOW-AXFR', 'pirate-axfr'
   WHERE NOT EXISTS (
     SELECT 1
       FROM domainmetadata
      WHERE domain_id = NEW.id
        AND kind = 'TSIG-ALLOW-AXFR'
        AND content = 'pirate-axfr'
   );
END
